use brass_engine_core::{decode_program_words, FiberMachine, FiberMachineStatus, Node};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    version: u32,
    event_fiber_id: u32,
    cases: Vec<Case>,
    host_lifecycle: Vec<HostLifecycle>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    program_words: Vec<u32>,
    steps: Vec<Step>,
    terminal: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    op: String,
    #[serde(default)]
    r#ref: u32,
    #[serde(default)]
    root: u32,
    #[serde(default)]
    nodes: Vec<[u32; 4]>,
    event_words: [u32; 5],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostLifecycle {
    name: String,
    owner: String,
    expected_finalizer_order: Vec<String>,
    expected_child_cancels: u32,
    expected_async_resumes: u32,
    expected_orphans: u32,
}

#[test]
fn shared_native_lifecycle_corpus_matches_the_portable_machine() {
    let corpus: Corpus =
        serde_json::from_str(include_str!("../../../fixtures/native-lifecycle-v1.json"))
            .expect("versioned corpus JSON");
    assert_eq!(corpus.version, 1);
    assert_eq!(corpus.event_fiber_id, 0);
    assert!(!corpus.cases.is_empty());

    for case in corpus.cases {
        let program = decode_program_words(&case.program_words)
            .unwrap_or_else(|error| panic!("{} program: {error}", case.name));
        let mut machine = FiberMachine::new(7, program);
        for step in case.steps {
            let event = match step.op.as_str() {
                "poll" => machine.poll(),
                "provideValue" => machine.provide_value(step.r#ref),
                "provideError" => machine.provide_error(step.r#ref),
                "interrupt" => machine.interrupt(step.r#ref),
                "provideEffect" => machine
                    .provide_effect(
                        step.root,
                        step.nodes
                            .into_iter()
                            .map(|word| Node::new(word[0], word[1], word[2], word[3]))
                            .collect(),
                    )
                    .unwrap_or_else(|error| panic!("{} patch: {error}", case.name)),
                other => panic!("{} has unknown operation {other}", case.name),
            };
            let mut words = event.words();
            words[1] = corpus.event_fiber_id;
            assert_eq!(words, step.event_words, "{} / {}", case.name, step.op);
        }

        let terminal = match machine.status() {
            FiberMachineStatus::Done => "done",
            FiberMachineStatus::Failed => "failed",
            FiberMachineStatus::Interrupted => "interrupted",
            FiberMachineStatus::Running => "running",
            FiberMachineStatus::Suspended => "suspended",
        };
        assert_eq!(terminal, case.terminal, "{} terminal", case.name);
    }

    for lifecycle in corpus.host_lifecycle {
        assert_eq!(lifecycle.owner, "typescript", "{} owner", lifecycle.name);
        assert_eq!(lifecycle.expected_finalizer_order, ["child", "parent"]);
        assert_eq!(lifecycle.expected_child_cancels, 1);
        assert_eq!(lifecycle.expected_async_resumes, 1);
        assert_eq!(lifecycle.expected_orphans, 0);
    }
}
