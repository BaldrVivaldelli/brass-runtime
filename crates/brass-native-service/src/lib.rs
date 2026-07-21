use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_DOCUMENTS: usize = 4_096;
pub const MAX_DOCUMENT_BYTES: usize = 256 * 1024;
pub const MAX_TOTAL_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_QUERY_BYTES: usize = 4_096;
pub const MAX_SEARCH_RESULTS: usize = 100;
pub const MAX_ACTIVE_REQUESTS: usize = 16;
pub const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_millis(750);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexDocument {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    pub score: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceError {
    Cancelled,
    DeadlineExceeded,
    InvalidInput(&'static str),
    ResourceLimit(&'static str),
}

impl ServiceError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Cancelled => "CANCELLED",
            Self::DeadlineExceeded => "DEADLINE_EXCEEDED",
            Self::InvalidInput(_) => "INVALID_INPUT",
            Self::ResourceLimit(_) => "RESOURCE_LIMIT",
        }
    }

    pub const fn message(&self) -> &'static str {
        match self {
            Self::Cancelled => "request cancelled",
            Self::DeadlineExceeded => "request deadline exceeded",
            Self::InvalidInput(message) | Self::ResourceLimit(message) => message,
        }
    }
}

#[derive(Default)]
pub struct SearchIndex {
    workspaces: HashMap<String, HashMap<String, String>>,
}

impl SearchIndex {
    pub fn replace(
        &mut self,
        workspace_id: &str,
        documents: Vec<IndexDocument>,
        cancelled: &AtomicBool,
        deadline_ms: u64,
    ) -> Result<usize, ServiceError> {
        validate_workspace_id(workspace_id)?;
        if documents.len() > MAX_DOCUMENTS {
            return Err(ServiceError::ResourceLimit(
                "document count exceeds service limit",
            ));
        }
        let mut total_bytes = 0usize;
        let mut next = HashMap::with_capacity(documents.len());
        for document in documents {
            checkpoint(cancelled, deadline_ms)?;
            if document.id.is_empty() || document.id.len() > 512 {
                return Err(ServiceError::InvalidInput(
                    "document id is empty or too large",
                ));
            }
            if document.text.len() > MAX_DOCUMENT_BYTES {
                return Err(ServiceError::ResourceLimit(
                    "document exceeds service byte limit",
                ));
            }
            let normalized_text = document.text.to_ascii_lowercase();
            if normalized_text.len() > MAX_DOCUMENT_BYTES {
                return Err(ServiceError::ResourceLimit(
                    "normalized document exceeds service byte limit",
                ));
            }
            total_bytes = total_bytes
                .checked_add(normalized_text.len())
                .ok_or(ServiceError::ResourceLimit("document byte count overflow"))?;
            if total_bytes > MAX_TOTAL_DOCUMENT_BYTES {
                return Err(ServiceError::ResourceLimit(
                    "workspace document bytes exceed service limit",
                ));
            }
            next.insert(document.id, normalized_text);
        }
        checkpoint(cancelled, deadline_ms)?;
        let count = next.len();
        self.workspaces.insert(workspace_id.to_owned(), next);
        Ok(count)
    }

    pub fn search(
        &self,
        workspace_id: &str,
        query: &str,
        limit: usize,
        cancelled: &AtomicBool,
        deadline_ms: u64,
    ) -> Result<Vec<SearchHit>, ServiceError> {
        validate_workspace_id(workspace_id)?;
        if query.is_empty() || query.len() > MAX_QUERY_BYTES {
            return Err(ServiceError::InvalidInput("query is empty or too large"));
        }
        let requested_limit = limit.clamp(1, MAX_SEARCH_RESULTS);
        let terms: Vec<String> = query
            .split_ascii_whitespace()
            .take(64)
            .map(str::to_ascii_lowercase)
            .collect();
        if terms.is_empty() {
            return Err(ServiceError::InvalidInput(
                "query contains no searchable terms",
            ));
        }
        checkpoint(cancelled, deadline_ms)?;
        let Some(documents) = self.workspaces.get(workspace_id) else {
            return Ok(Vec::new());
        };
        let mut hits = Vec::new();
        for (id, text) in documents {
            checkpoint(cancelled, deadline_ms)?;
            let score = terms
                .iter()
                .map(|term| text.match_indices(term).count() as u32)
                .sum();
            if score > 0 {
                hits.push(SearchHit {
                    id: id.clone(),
                    score,
                });
            }
        }
        hits.sort_unstable_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.id.cmp(&right.id))
        });
        hits.truncate(requested_limit);
        Ok(hits)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RpcRequest {
    protocol_version: u32,
    id: String,
    session_id: String,
    #[serde(default)]
    workspace_id: String,
    #[serde(default)]
    nonce: String,
    #[serde(default)]
    deadline_ms: u64,
    #[serde(default)]
    priority: i32,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelloParams {
    client_build: String,
    max_message_bytes: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexParams {
    documents: Vec<IndexDocument>,
}

#[derive(Debug, Deserialize)]
struct SearchParams {
    query: String,
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelParams {
    target_request_id: String,
}

type SharedWriter = Arc<Mutex<BufWriter<io::Stdout>>>;
type ActiveRequests = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

pub fn run_stdio() -> io::Result<()> {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let writer = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let index = Arc::new(Mutex::new(SearchIndex::default()));
    let active: ActiveRequests = Arc::new(Mutex::new(HashMap::new()));
    let mut session: Option<(String, String, usize)> = None;

    loop {
        let frame = match read_bounded_frame(&mut reader, MAX_MESSAGE_BYTES)? {
            FrameRead::Eof => break,
            FrameRead::TooLarge => {
                send_protocol_error(
                    &writer,
                    "unknown",
                    "MESSAGE_TOO_LARGE",
                    "message exceeds service limit",
                )?;
                continue;
            }
            FrameRead::Frame(frame) => frame,
        };
        if frame.is_empty() {
            continue;
        }
        let request: RpcRequest = match serde_json::from_slice(&frame) {
            Ok(value) => value,
            Err(_) => {
                send_protocol_error(&writer, "unknown", "INVALID_JSON", "invalid JSON request")?;
                continue;
            }
        };
        if request.protocol_version != PROTOCOL_VERSION {
            send_request_error(
                &writer,
                &request,
                "UNSUPPORTED_PROTOCOL",
                "unsupported protocol version",
            )?;
            continue;
        }
        if request.id.is_empty()
            || request.id.len() > 128
            || request.priority.unsigned_abs() > 1_000
        {
            send_request_error(
                &writer,
                &request,
                "INVALID_REQUEST",
                "invalid request metadata",
            )?;
            continue;
        }

        if request.method == "hello" {
            if session.is_some() || request.session_id.is_empty() || request.nonce.is_empty() {
                send_request_error(
                    &writer,
                    &request,
                    "AUTH_FAILED",
                    "invalid or repeated handshake",
                )?;
                continue;
            }
            let params: HelloParams = match serde_json::from_value(request.params.clone()) {
                Ok(value) => value,
                Err(_) => {
                    send_request_error(
                        &writer,
                        &request,
                        "INVALID_INPUT",
                        "invalid handshake params",
                    )?;
                    continue;
                }
            };
            if params.client_build.is_empty()
                || params.client_build.len() > 128
                || params.max_message_bytes == 0
            {
                send_request_error(
                    &writer,
                    &request,
                    "INVALID_INPUT",
                    "invalid handshake limits",
                )?;
                continue;
            }
            let negotiated = params.max_message_bytes.min(MAX_MESSAGE_BYTES);
            session = Some((
                request.session_id.clone(),
                request.nonce.clone(),
                negotiated,
            ));
            send_simple_result(
                &writer,
                &request,
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "serviceBuild": env!("CARGO_PKG_VERSION"),
                    "capabilities": ["health", "index.replace", "search", "cancel", "shutdown"],
                    "maxMessageBytes": negotiated,
                    "maxDocuments": MAX_DOCUMENTS,
                    "maxActiveRequests": MAX_ACTIVE_REQUESTS,
                    "readOnly": true
                }),
            )?;
            continue;
        }

        let Some((session_id, nonce, negotiated_limit)) = &session else {
            send_request_error(
                &writer,
                &request,
                "HANDSHAKE_REQUIRED",
                "handshake required",
            )?;
            continue;
        };
        if &request.session_id != session_id || &request.nonce != nonce {
            send_request_error(
                &writer,
                &request,
                "AUTH_FAILED",
                "session authentication failed",
            )?;
            continue;
        }
        if frame.len() > *negotiated_limit {
            send_request_error(
                &writer,
                &request,
                "MESSAGE_TOO_LARGE",
                "message exceeds negotiated limit",
            )?;
            continue;
        }

        match request.method.as_str() {
            "health" => {
                send_simple_result(
                    &writer,
                    &request,
                    json!({ "ok": true, "activeRequests": lock(&active).len(), "readOnly": true }),
                )?;
            }
            "cancel" => {
                let params: CancelParams = match serde_json::from_value(request.params.clone()) {
                    Ok(value) => value,
                    Err(_) => {
                        send_request_error(
                            &writer,
                            &request,
                            "INVALID_INPUT",
                            "invalid cancel params",
                        )?;
                        continue;
                    }
                };
                let accepted = lock(&active)
                    .get(&params.target_request_id)
                    .is_some_and(|token| {
                        token.store(true, Ordering::Release);
                        true
                    });
                send_simple_result(&writer, &request, json!({ "accepted": accepted }))?;
            }
            "index.replace" => {
                let params: IndexParams = match serde_json::from_value(request.params.clone()) {
                    Ok(value) => value,
                    Err(_) => {
                        send_request_error(
                            &writer,
                            &request,
                            "INVALID_INPUT",
                            "invalid index params",
                        )?;
                        continue;
                    }
                };
                if let Err(error) = validate_async_request(&request, &active) {
                    send_service_error(&writer, &request, error)?;
                    continue;
                }
                let token = register_active(&active, &request.id);
                let writer = Arc::clone(&writer);
                let index = Arc::clone(&index);
                let active = Arc::clone(&active);
                let request_bytes = frame.len();
                std::thread::spawn(move || {
                    send_progress(&writer, &request, "indexing", 0, params.documents.len());
                    let started = Instant::now();
                    let at = unix_ms();
                    let result = lock(&index).replace(
                        &request.workspace_id,
                        params.documents,
                        &token,
                        request.deadline_ms,
                    );
                    let outcome = match result {
                        Ok(document_count) => Ok(json!({ "documentCount": document_count })),
                        Err(error) => Err(error),
                    };
                    let queue_depth = lock(&active).len().saturating_sub(1);
                    finish_async(
                        &writer,
                        &request,
                        outcome,
                        started,
                        at,
                        request_bytes,
                        queue_depth,
                    );
                    lock(&active).remove(&request.id);
                });
            }
            "search" => {
                let params: SearchParams = match serde_json::from_value(request.params.clone()) {
                    Ok(value) => value,
                    Err(_) => {
                        send_request_error(
                            &writer,
                            &request,
                            "INVALID_INPUT",
                            "invalid search params",
                        )?;
                        continue;
                    }
                };
                if let Err(error) = validate_async_request(&request, &active) {
                    send_service_error(&writer, &request, error)?;
                    continue;
                }
                let token = register_active(&active, &request.id);
                let writer = Arc::clone(&writer);
                let index = Arc::clone(&index);
                let active = Arc::clone(&active);
                let request_bytes = frame.len();
                std::thread::spawn(move || {
                    send_progress(&writer, &request, "searching", 0, 1);
                    let started = Instant::now();
                    let at = unix_ms();
                    let result = lock(&index).search(
                        &request.workspace_id,
                        &params.query,
                        params.limit,
                        &token,
                        request.deadline_ms,
                    );
                    let outcome = match result {
                        Ok(hits) => Ok(json!({ "hits": hits })),
                        Err(error) => Err(error),
                    };
                    let queue_depth = lock(&active).len().saturating_sub(1);
                    finish_async(
                        &writer,
                        &request,
                        outcome,
                        started,
                        at,
                        request_bytes,
                        queue_depth,
                    );
                    lock(&active).remove(&request.id);
                });
            }
            "shutdown" => {
                for token in lock(&active).values() {
                    token.store(true, Ordering::Release);
                }
                let drained = wait_for_active_drain(&active, SHUTDOWN_DRAIN_TIMEOUT);
                send_simple_result(
                    &writer,
                    &request,
                    json!({
                        "shuttingDown": true,
                        "drained": drained,
                        "activeRequests": lock(&active).len()
                    }),
                )?;
                break;
            }
            _ => send_request_error(
                &writer,
                &request,
                "METHOD_NOT_FOUND",
                "unknown service method",
            )?,
        }
    }
    Ok(())
}

fn wait_for_active_drain(active: &ActiveRequests, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if lock(active).is_empty() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn validate_workspace_id(value: &str) -> Result<(), ServiceError> {
    if value.is_empty() || value.len() > 128 {
        return Err(ServiceError::InvalidInput(
            "workspace id is empty or too large",
        ));
    }
    Ok(())
}

fn checkpoint(cancelled: &AtomicBool, deadline_ms: u64) -> Result<(), ServiceError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(ServiceError::Cancelled);
    }
    if deadline_ms != 0 && unix_ms() >= deadline_ms {
        return Err(ServiceError::DeadlineExceeded);
    }
    Ok(())
}

fn validate_async_request(
    request: &RpcRequest,
    active: &ActiveRequests,
) -> Result<(), ServiceError> {
    validate_workspace_id(&request.workspace_id)?;
    checkpoint(&AtomicBool::new(false), request.deadline_ms)?;
    let active_requests = lock(active);
    if active_requests.contains_key(&request.id) {
        return Err(ServiceError::InvalidInput("duplicate active request id"));
    }
    if active_requests.len() >= MAX_ACTIVE_REQUESTS {
        return Err(ServiceError::ResourceLimit("too many active requests"));
    }
    Ok(())
}

fn register_active(active: &ActiveRequests, request_id: &str) -> Arc<AtomicBool> {
    let token = Arc::new(AtomicBool::new(false));
    lock(active).insert(request_id.to_owned(), Arc::clone(&token));
    token
}

fn finish_async(
    writer: &SharedWriter,
    request: &RpcRequest,
    outcome: Result<Value, ServiceError>,
    started: Instant,
    at: u64,
    request_bytes: usize,
    queue_depth: usize,
) {
    let (response, result, error_code) = match outcome {
        Ok(result) => (response_value(request, Some(result), None), "success", None),
        Err(error) => {
            let result = if error == ServiceError::Cancelled {
                "cancelled"
            } else {
                "error"
            };
            (
                response_value(
                    request,
                    None,
                    Some(json!({ "code": error.code(), "message": error.message() })),
                ),
                result,
                Some(error.code()),
            )
        }
    };
    let response_bytes = serde_json::to_vec(&response).map_or(0, |bytes| bytes.len());
    let mut boundary_event = json!({
        "version": 1,
        "type": "runtime.boundary",
        "boundary": "ipc-rust",
        "operation": request.method,
        "at": at,
        "durationMs": started.elapsed().as_secs_f64() * 1000.0,
        "requestBytes": request_bytes,
        "responseBytes": response_bytes,
        "result": result,
        "correlationId": request.id,
        "queueDepth": queue_depth
    });
    if let (Some(code), Some(object)) = (error_code, boundary_event.as_object_mut()) {
        object.insert("errorCode".to_owned(), Value::String(code.to_owned()));
    }
    let boundary = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "type": "event",
        "event": boundary_event
    });
    let mut terminal_event = json!({
        "version": 1,
        "type": "native.terminal",
        "requestId": request.id,
        "outcome": result
    });
    if let (Some(code), Some(object)) = (error_code, terminal_event.as_object_mut()) {
        object.insert("errorCode".to_owned(), Value::String(code.to_owned()));
    }
    let terminal = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "type": "event",
        "event": terminal_event
    });
    if let Ok(mut output) = writer.lock() {
        let _ = write_value(&mut *output, &boundary);
        let _ = write_value(&mut *output, &response);
        let _ = write_value(&mut *output, &terminal);
        let _ = output.flush();
    }
}

fn send_progress(
    writer: &SharedWriter,
    request: &RpcRequest,
    phase: &str,
    completed: usize,
    total: usize,
) {
    let event = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "type": "event",
        "event": {
            "version": 1,
            "type": "native.progress",
            "requestId": request.id,
            "phase": phase,
            "completed": completed,
            "total": total
        }
    });
    if let Ok(mut output) = writer.lock() {
        let _ = write_value(&mut *output, &event);
        let _ = output.flush();
    }
}

fn send_simple_result(
    writer: &SharedWriter,
    request: &RpcRequest,
    result: Value,
) -> io::Result<()> {
    send_value(writer, &response_value(request, Some(result), None))
}

fn send_service_error(
    writer: &SharedWriter,
    request: &RpcRequest,
    error: ServiceError,
) -> io::Result<()> {
    send_value(
        writer,
        &response_value(
            request,
            None,
            Some(json!({ "code": error.code(), "message": error.message() })),
        ),
    )
}

fn send_request_error(
    writer: &SharedWriter,
    request: &RpcRequest,
    code: &str,
    message: &str,
) -> io::Result<()> {
    send_value(
        writer,
        &response_value(
            request,
            None,
            Some(json!({ "code": code, "message": message })),
        ),
    )
}

fn send_protocol_error(
    writer: &SharedWriter,
    id: &str,
    code: &str,
    message: &str,
) -> io::Result<()> {
    send_value(
        writer,
        &json!({
            "protocolVersion": PROTOCOL_VERSION,
            "type": "response",
            "id": id,
            "sessionId": "",
            "error": { "code": code, "message": message }
        }),
    )
}

fn response_value(request: &RpcRequest, result: Option<Value>, error: Option<Value>) -> Value {
    let mut response = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "type": "response",
        "id": request.id,
        "sessionId": request.session_id,
    });
    if let Some(object) = response.as_object_mut() {
        if let Some(result) = result {
            object.insert("result".to_owned(), result);
        }
        if let Some(error) = error {
            object.insert("error".to_owned(), error);
        }
    }
    response
}

fn send_value(writer: &SharedWriter, value: &Value) -> io::Result<()> {
    let mut output = writer
        .lock()
        .map_err(|_| io::Error::other("native service output lock poisoned"))?;
    write_value(&mut *output, value)?;
    output.flush()
}

fn write_value(output: &mut impl Write, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, value).map_err(io::Error::other)?;
    output.write_all(b"\n")
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

enum FrameRead {
    Eof,
    Frame(Vec<u8>),
    TooLarge,
}

fn read_bounded_frame(reader: &mut impl BufRead, maximum: usize) -> io::Result<FrameRead> {
    let mut frame = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if frame.is_empty() {
                Ok(FrameRead::Eof)
            } else {
                trim_carriage_return(&mut frame);
                Ok(FrameRead::Frame(frame))
            };
        }
        let available_len = available.len();
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if frame.len().saturating_add(newline) > maximum {
                reader.consume(newline + 1);
                return Ok(FrameRead::TooLarge);
            }
            frame.extend_from_slice(&available[..newline]);
            reader.consume(newline + 1);
            trim_carriage_return(&mut frame);
            return Ok(FrameRead::Frame(frame));
        }
        if frame.len().saturating_add(available_len) > maximum {
            reader.consume(available_len);
            discard_to_newline(reader)?;
            return Ok(FrameRead::TooLarge);
        }
        frame.extend_from_slice(available);
        reader.consume(available_len);
    }
}

fn discard_to_newline(reader: &mut impl BufRead) -> io::Result<()> {
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(());
        }
        let length = available.len();
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            reader.consume(newline + 1);
            return Ok(());
        }
        reader.consume(length);
    }
}

fn trim_carriage_return(frame: &mut Vec<u8>) {
    if frame.last() == Some(&b'\r') {
        frame.pop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_and_search_are_deterministic_and_read_only() {
        let mut index = SearchIndex::default();
        let cancel = AtomicBool::new(false);
        assert_eq!(
            index.replace(
                "workspace",
                vec![
                    IndexDocument {
                        id: "b".into(),
                        text: "Rust brass".into()
                    },
                    IndexDocument {
                        id: "a".into(),
                        text: "brass brass runtime".into()
                    },
                ],
                &cancel,
                0,
            ),
            Ok(2)
        );
        assert_eq!(
            index.search("workspace", "brass", 10, &cancel, 0),
            Ok(vec![
                SearchHit {
                    id: "a".into(),
                    score: 2
                },
                SearchHit {
                    id: "b".into(),
                    score: 1
                },
            ])
        );
    }

    #[test]
    fn utf8_limits_ascii_fold_and_byte_order_match_the_typescript_contract() {
        let mut index = SearchIndex::default();
        let cancel = AtomicBool::new(false);
        index
            .replace(
                "workspace",
                vec![
                    IndexDocument {
                        id: "virtual:\u{10000}".into(),
                        text: "marker CAFÉ".into(),
                    },
                    IndexDocument {
                        id: "virtual:\u{e000}".into(),
                        text: "marker café".into(),
                    },
                ],
                &cancel,
                0,
            )
            .expect("the Unicode fixture must be valid");
        assert_eq!(
            index.search("workspace", "marker", 10, &cancel, 0),
            Ok(vec![
                SearchHit {
                    id: "virtual:\u{e000}".into(),
                    score: 1,
                },
                SearchHit {
                    id: "virtual:\u{10000}".into(),
                    score: 1,
                },
            ])
        );
        assert_eq!(
            index.search("workspace", "café", 10, &cancel, 0),
            Ok(vec![SearchHit {
                id: "virtual:\u{e000}".into(),
                score: 1,
            }])
        );
        assert_eq!(
            index.replace(
                "workspace",
                vec![IndexDocument {
                    id: "large".into(),
                    text: "😀".repeat(70_000),
                }],
                &cancel,
                0,
            ),
            Err(ServiceError::ResourceLimit(
                "document exceeds service byte limit"
            ))
        );
    }

    #[test]
    fn cancellation_deadlines_and_bounds_are_recoverable() {
        let mut index = SearchIndex::default();
        let cancelled = AtomicBool::new(true);
        assert_eq!(
            index.replace("workspace", Vec::new(), &cancelled, 0),
            Err(ServiceError::Cancelled)
        );
        let active = AtomicBool::new(false);
        assert_eq!(
            index.search("workspace", "query", 1, &active, 1),
            Err(ServiceError::DeadlineExceeded)
        );
        assert_eq!(
            index.replace(
                "workspace",
                vec![IndexDocument {
                    id: "a".into(),
                    text: "x".repeat(MAX_DOCUMENT_BYTES + 1)
                }],
                &active,
                0,
            ),
            Err(ServiceError::ResourceLimit(
                "document exceeds service byte limit"
            ))
        );
    }

    #[test]
    fn bounded_reader_discards_oversized_frames_and_recovers() {
        let input = b"123456\nok\n";
        let mut reader = BufReader::new(&input[..]);
        assert!(matches!(
            read_bounded_frame(&mut reader, 4),
            Ok(FrameRead::TooLarge)
        ));
        match read_bounded_frame(&mut reader, 4) {
            Ok(FrameRead::Frame(value)) => assert_eq!(value, b"ok"),
            _ => panic!("expected the next bounded frame"),
        }
    }

    #[test]
    fn canonical_ipc_v1_requests_round_trip_without_loss() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../fixtures/native-ipc-v1.json"))
                .expect("the canonical IPC fixture must be valid JSON");
        let requests = fixture["requests"]
            .as_array()
            .expect("the canonical IPC fixture must contain requests");
        for request in requests {
            let decoded: RpcRequest = serde_json::from_value(request.clone())
                .expect("Rust must decode every canonical IPC request");
            let encoded = serde_json::to_value(decoded)
                .expect("Rust must encode every canonical IPC request");
            assert_eq!(&encoded, request);
        }
        let encoded_fixture =
            serde_json::to_vec(&fixture).expect("Rust must encode the canonical IPC fixture");
        let decoded_fixture: Value = serde_json::from_slice(&encoded_fixture)
            .expect("Rust must decode its encoded canonical IPC fixture");
        assert_eq!(decoded_fixture, fixture);
    }
}
