# VS Code enhanced diff preview

P35 improves the patch preview Webview used by Brass Agent.

The extension still does not apply patches directly. The Webview is only a review and approval surface; applying still goes through `brass-agent --apply-patch-file`.

## What the preview shows

The preview now groups unified diffs by file and shows:

```txt
file count
added / removed lines
per-file hunks
per-file patch sections
```

Each file section can be expanded or collapsed.

## Actions

The preview supports:

```txt
Apply Patch
Copy Full Patch
Collapse All
Expand All
Open file
Copy file patch
Close
```

`Open file` resolves the path inside the workspace before opening it. Paths outside the workspace are rejected.

## Safety

The apply flow is unchanged:

```txt
Patch Preview
  -> user approves exact diff
  -> brass-agent --apply-patch-file <temp.diff> --yes
  -> PermissionService / PatchService / git apply --check / git apply
```
