//! #7952: the code graph over graft's wiring, read the way the app reads git: a CLI run in the
//! checkout (or a seat worktree), collapsed here so symbol nodes never cross the bridge.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;

use serde::{Deserialize, Serialize};

pub(crate) const NOT_INSTALLED: &str = "graft not installed";
const WIRING: &str = "graft/.graph/wiring.json";
const DOC_EXTENSIONS: [&str; 5] = ["md", "mdx", "markdown", "txt", "rst"];
const ENTRY_BASENAMES: [&str; 14] = [
    "main",
    "index",
    "app",
    "server",
    "cli",
    "setup",
    "manage",
    "conftest",
    "__init__",
    "__main__",
    "preload",
    "background",
    "worker",
    "extension",
];

#[derive(Deserialize)]
struct Wiring {
    nodes: Vec<WiringNode>,
    edges: Vec<WiringEdge>,
}

#[derive(Deserialize)]
struct WiringNode {
    kind: String,
    path: String,
    #[serde(default)]
    chars: u64,
}

#[derive(Deserialize)]
struct WiringEdge {
    source: String,
    target: String,
    relation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphNode {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) cluster: String,
    pub(crate) chars: u64,
    pub(crate) in_degree: u32,
    pub(crate) out_degree: u32,
    pub(crate) is_test: bool,
    /// How many test files import this one (Flare's count, not a list).
    pub(crate) tested_by: u32,
    pub(crate) orphan: bool,
    pub(crate) doc: bool,
    pub(crate) cycle_id: Option<u32>,
    /// Flare's branch-keyword count over comment-stripped source (#7978); 0 for prose.
    pub(crate) complexity: u32,
    /// TODO / FIXME / HACK / XXX as whole words, over the raw source.
    pub(crate) todos: u32,
    /// Commits touching the path in the last 90 days.
    pub(crate) churn: u32,
}

/// What the Hotspots lens reads beside the wiring: measured per file, churn from git.
#[derive(Debug, Default)]
pub(crate) struct Signals {
    /// path -> (complexity, todos)
    measured: BTreeMap<String, (u32, u32)>,
    churn: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct GraphEdge {
    pub(crate) source: String,
    pub(crate) target: String,
    /// "imports" when any import edge joins the pair, else "calls".
    pub(crate) relation: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphMeta {
    pub(crate) files: usize,
    pub(crate) edges: usize,
    /// Edges whose target graft could not resolve in-repo (node:fs, npm packages); dropped.
    pub(crate) external_targets: usize,
    pub(crate) cycles: u32,
    pub(crate) build_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct CodeGraph {
    pub(crate) root: String,
    pub(crate) nodes: Vec<GraphNode>,
    pub(crate) edges: Vec<GraphEdge>,
    pub(crate) meta: GraphMeta,
}

/// The lens reads `error` off the payload; a missing binary is a message there, never a
/// rejected promise and never an empty graph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub(crate) enum Response {
    Graph(CodeGraph),
    Error { error: String },
}

fn is_executable(candidate: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(candidate)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// The graft binary as the given PATH string finds it. Only PATH is consulted, so a PATH
/// without graft yields None and the error string, which is what the drill checks.
pub(crate) fn resolve_on(path_env: &str) -> Option<PathBuf> {
    path_env
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join("graft"))
        .find(|candidate| is_executable(candidate))
}

fn run_build(graft: &Path, root: &Path, path_env: &str) -> Result<(), String> {
    let out = std::process::Command::new(graft)
        .arg("build")
        .arg(".")
        .current_dir(root)
        .env("PATH", path_env)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("graft could not start: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let tail = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("no output");
    Err(format!("graft build failed ({}): {tail}", out.status))
}

fn read_wiring(root: &Path) -> Result<Wiring, String> {
    let file = root.join(WIRING);
    let raw = std::fs::read(&file).map_err(|e| format!("cannot read {WIRING}: {e}"))?;
    serde_json::from_slice(&raw).map_err(|e| format!("cannot parse {WIRING}: {e}"))
}

/// Build in `root`, read the wiring, collapse. `graft` is the resolved binary or None.
pub(crate) fn build_graph(root: &Path, graft: Option<&Path>, path_env: &str) -> Response {
    let Some(graft) = graft else {
        return Response::Error {
            error: NOT_INSTALLED.to_string(),
        };
    };
    let started = Instant::now();
    let built = run_build(graft, root, path_env).and_then(|()| read_wiring(root));
    match built {
        Ok(wiring) => {
            let files: Vec<&str> = wiring
                .nodes
                .iter()
                .filter(|node| node.kind == "file")
                .map(|node| node.path.as_str())
                .collect();
            let signals = Signals {
                measured: measure(root, &files),
                churn: git_churn(root, path_env),
            };
            Response::Graph(derive(
                &wiring,
                &root.to_string_lossy(),
                started.elapsed().as_millis() as u64,
                &signals,
            ))
        }
        Err(error) => Response::Error { error },
    }
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Flare's `PRESERVE_STRING_RE`: the quote that follows `from`, `import`, `import(` or
/// `require(` opens an import specifier, whose text the strip keeps.
fn preserves_string(recent: &str) -> bool {
    let ends_with_word = |text: &str, word: &str| {
        text.ends_with(word) && !text[..text.len() - word.len()].chars().last().is_some_and(is_word)
    };
    let trimmed = recent.trim_end();
    match trimmed.strip_suffix('(') {
        Some(before) => {
            let before = before.trim_end();
            ends_with_word(before, "import") || ends_with_word(before, "require")
        }
        None => ends_with_word(trimmed, "from") || ends_with_word(trimmed, "import"),
    }
}

/// The last 32 chars, Flare's `recent.slice(-32)`.
fn tail32(text: &str) -> &str {
    let cut = text.char_indices().rev().nth(31).map_or(0, |(at, _)| at);
    &text[cut..]
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StripState {
    Code,
    Line,
    Block,
    Single,
    Double,
    Template,
}

/// Flare's `stripJsComments` (parser.ts): comments and string bodies become spaces, import
/// specifiers and line structure survive, `${ }` nests inside template literals.
pub(crate) fn strip_js_comments(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let n = chars.len();
    let mut out = String::with_capacity(src.len());
    let mut recent = String::new();
    let mut state = StripState::Code;
    let mut template_stack: Vec<u32> = Vec::new();
    let mut preserve = false;
    let mut i = 0;
    // `recent` is the tail of emitted code the preserve check reads; trimmed in batches.
    let push_code = |out: &mut String, recent: &mut String, text: &str| {
        out.push_str(text);
        recent.push_str(text);
        if recent.len() > 256 {
            let cut = recent.char_indices().rev().nth(31).map_or(0, |(at, _)| at);
            recent.drain(..cut);
        }
    };
    while i < n {
        let c = chars[i];
        let next = if i + 1 < n { Some(chars[i + 1]) } else { None };
        match state {
            StripState::Code => {
                if c == '/' && next == Some('/') {
                    state = StripState::Line;
                    out.push_str("  ");
                    i += 2;
                    continue;
                }
                if c == '/' && next == Some('*') {
                    state = StripState::Block;
                    out.push_str("  ");
                    i += 2;
                    continue;
                }
                if c == '\'' || c == '"' {
                    state = if c == '\'' { StripState::Single } else { StripState::Double };
                    preserve = preserves_string(tail32(&recent));
                    push_code(&mut out, &mut recent, c.encode_utf8(&mut [0; 4]));
                    i += 1;
                    continue;
                }
                if c == '`' {
                    state = StripState::Template;
                    template_stack.push(0);
                    push_code(&mut out, &mut recent, "`");
                    i += 1;
                    continue;
                }
                if c == '}' && !template_stack.is_empty() {
                    let depth = *template_stack.last().unwrap_or(&0);
                    if depth == 0 {
                        state = StripState::Template;
                        push_code(&mut out, &mut recent, "}");
                        i += 1;
                        continue;
                    }
                    if let Some(top) = template_stack.last_mut() {
                        *top -= 1;
                    }
                } else if c == '{' && !template_stack.is_empty() {
                    if let Some(top) = template_stack.last_mut() {
                        *top += 1;
                    }
                }
                push_code(&mut out, &mut recent, c.encode_utf8(&mut [0; 4]));
                i += 1;
            }
            StripState::Line => {
                if c == '\n' {
                    state = StripState::Code;
                    out.push('\n');
                } else {
                    out.push(' ');
                }
                i += 1;
            }
            StripState::Block => {
                if c == '*' && next == Some('/') {
                    state = StripState::Code;
                    out.push_str("  ");
                    i += 2;
                    continue;
                }
                out.push(if c == '\n' { '\n' } else { ' ' });
                i += 1;
            }
            StripState::Single | StripState::Double => {
                let quote = if state == StripState::Single { '\'' } else { '"' };
                if c == '\\' {
                    if preserve {
                        out.extend(chars[i..(i + 2).min(n)].iter());
                    } else {
                        out.push_str("  ");
                    }
                    i += 2;
                    continue;
                }
                if c == quote || c == '\n' {
                    state = StripState::Code;
                    push_code(&mut out, &mut recent, c.encode_utf8(&mut [0; 4]));
                    i += 1;
                    continue;
                }
                out.push(if preserve { c } else { ' ' });
                i += 1;
            }
            StripState::Template => {
                if c == '\\' {
                    out.push_str("  ");
                    i += 2;
                    continue;
                }
                if c == '`' {
                    state = StripState::Code;
                    template_stack.pop();
                    push_code(&mut out, &mut recent, "`");
                    i += 1;
                    continue;
                }
                if c == '$' && next == Some('{') {
                    state = StripState::Code;
                    push_code(&mut out, &mut recent, "${");
                    i += 2;
                    continue;
                }
                out.push(if c == '\n' { '\n' } else { ' ' });
                i += 1;
            }
        }
    }
    out
}

/// Whole-word hits, `\b(a|b)\b` with JS's ASCII word class.
fn count_words(text: &str, words: &[&str]) -> u32 {
    let mut count = 0;
    let mut run = String::new();
    for c in text.chars().chain(std::iter::once(' ')) {
        if is_word(c) {
            run.push(c);
            continue;
        }
        if !run.is_empty() && words.contains(&run.as_str()) {
            count += 1;
        }
        run.clear();
    }
    count
}

/// Flare's `jsComplexity` over stripped source: branch keywords, `&&`/`||`, and `?` not
/// followed by `.`, `?` or `:` (so `a ?? b` counts once, as Flare counts it).
pub(crate) fn js_complexity(stripped: &str) -> u32 {
    let keywords = count_words(stripped, &["if", "for", "while", "case", "catch", "do"]);
    let chars: Vec<char> = stripped.chars().collect();
    let mut logical = 0;
    let mut ternary = 0;
    let mut i = 0;
    while i < chars.len() {
        let pair = (chars[i], chars.get(i + 1).copied());
        if matches!(pair, ('&', Some('&')) | ('|', Some('|'))) {
            logical += 1;
            i += 2;
            continue;
        }
        i += 1;
    }
    i = 0;
    while i + 1 < chars.len() {
        if chars[i] == '?' && !matches!(chars[i + 1], '.' | '?' | ':') {
            ternary += 1;
            i += 2;
            continue;
        }
        i += 1;
    }
    keywords + logical + ternary
}

/// Flare's `pyComplexity`: `#` comments cut per line, then the Python branch words.
pub(crate) fn py_complexity(source: &str) -> u32 {
    let stripped: String = source
        .lines()
        .map(|line| line.split_once('#').map_or(line, |(code, _)| code))
        .collect::<Vec<_>>()
        .join("\n");
    count_words(&stripped, &["if", "elif", "for", "while", "except", "and", "or", "case"])
}

/// Flare's `countTodos`, over the raw source, comments included.
pub(crate) fn count_todos(content: &str) -> u32 {
    count_words(content, &["TODO", "FIXME", "HACK", "XXX"])
}

/// Flare scores JS/TS and Python and leaves prose at 0; every other code file graft indexed
/// (Rust here) takes the JS rule, whose comments and branch words read the same way.
pub(crate) fn complexity_of(path: &str, content: &str) -> u32 {
    if is_doc_path(path) {
        return 0;
    }
    let ext = path.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase());
    if ext.as_deref() == Some("py") {
        return py_complexity(content);
    }
    js_complexity(&strip_js_comments(content))
}

/// (complexity, todos) per file, read off the scope's tree; a file gone since the build is 0.
fn measure(root: &Path, files: &[&str]) -> BTreeMap<String, (u32, u32)> {
    files
        .iter()
        .map(|path| {
            let content = std::fs::read(root.join(path))
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_default();
            (path.to_string(), (complexity_of(path, &content), count_todos(&content)))
        })
        .collect()
}

/// Commits per path over the last 90 days, paths relative to `root` like the wiring's.
pub(crate) fn git_churn(root: &Path, path_env: &str) -> BTreeMap<String, u32> {
    let mut churn = BTreeMap::new();
    let Ok(out) = std::process::Command::new("git")
        .args(["log", "--format=", "--name-only", "--since=90.days", "--relative"])
        .current_dir(root)
        .env("PATH", path_env)
        .stdin(Stdio::null())
        .output()
    else {
        return churn;
    };
    if !out.status.success() {
        return churn;
    }
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let path = line.trim();
        if !path.is_empty() {
            *churn.entry(path.to_string()).or_insert(0) += 1;
        }
    }
    churn
}

fn file_of(id: &str) -> &str {
    id.split_once('#').map_or(id, |(path, _)| path)
}

fn top_dir(path: &str) -> &str {
    path.split_once('/').map_or("", |(top, _)| top)
}

fn basename_stem(path: &str) -> &str {
    let base = path.rsplit('/').next().unwrap_or(path);
    base.rsplit_once('.').map_or(base, |(stem, _)| stem)
}

pub(crate) fn is_test_path(path: &str) -> bool {
    let in_test_dir = path.split('/').rev().skip(1).any(|segment| {
        matches!(
            segment,
            "test" | "tests" | "__tests__" | "e2e" | "spec" | "specs"
        )
    });
    let base = path.rsplit('/').next().unwrap_or(path);
    let mut parts = base.rsplit('.');
    let dotted_test = parts.next().is_some_and(|ext| !ext.is_empty())
        && parts.next().is_some_and(|tag| tag == "test" || tag == "spec");
    let py_test = base.ends_with(".py") && (base.starts_with("test_") || base.ends_with("_test.py"));
    in_test_dir || dotted_test || py_test
}

fn is_doc_path(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, ext)| DOC_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

fn is_entry_like(path: &str) -> bool {
    let stem = basename_stem(path).to_ascii_lowercase();
    ENTRY_BASENAMES.contains(&stem.as_str())
}

struct TopDir {
    direct: usize,
    total: usize,
    subs: BTreeSet<String>,
}

/// Flare's rule: cluster by top directory, except a container top (no code of its own, two or
/// more code-bearing subdirs, five or more files) clusters by its second level, e.g. apps/web.
fn cluster_of(files: &[&str]) -> impl Fn(&str) -> String {
    let mut tops: BTreeMap<String, TopDir> = BTreeMap::new();
    for path in files {
        let top = top_dir(path);
        if top.is_empty() {
            continue;
        }
        let entry = tops.entry(top.to_string()).or_insert_with(|| TopDir {
            direct: 0,
            total: 0,
            subs: BTreeSet::new(),
        });
        entry.total += 1;
        match path[top.len() + 1..].split_once('/') {
            Some((sub, _)) => {
                entry.subs.insert(sub.to_string());
            }
            None => entry.direct += 1,
        }
    }
    let two_level: BTreeSet<String> = tops
        .into_iter()
        .filter(|(_, entry)| entry.direct == 0 && entry.subs.len() >= 2 && entry.total >= 5)
        .map(|(top, _)| top)
        .collect();
    move |path: &str| {
        let top = top_dir(path);
        if !two_level.contains(top) {
            return top.to_string();
        }
        match path[top.len() + 1..].split_once('/') {
            Some((sub, _)) => format!("{top}/{sub}"),
            None => top.to_string(),
        }
    }
}

/// Iterative Tarjan SCC over adjacency by index: node -> component id for components of size
/// > 1, i.e. real cycles. Returns the ids and the component count.
fn find_cycles(adjacency: &[Vec<usize>]) -> (Vec<Option<u32>>, u32) {
    let n = adjacency.len();
    let mut index = vec![usize::MAX; n];
    let mut low = vec![0usize; n];
    let mut on_stack = vec![false; n];
    let mut stack: Vec<usize> = Vec::new();
    let mut result = vec![None; n];
    let mut counter = 0usize;
    let mut components = 0u32;
    for start in 0..n {
        if index[start] != usize::MAX {
            continue;
        }
        let mut work: Vec<(usize, usize)> = vec![(start, 0)];
        while let Some(&(node, mut next)) = work.last() {
            let top = work.len() - 1;
            if next == 0 {
                index[node] = counter;
                low[node] = counter;
                counter += 1;
                stack.push(node);
                on_stack[node] = true;
            }
            let mut recursed = false;
            while next < adjacency[node].len() {
                let child = adjacency[node][next];
                next += 1;
                work[top].1 = next;
                if index[child] == usize::MAX {
                    work.push((child, 0));
                    recursed = true;
                    break;
                }
                if on_stack[child] {
                    low[node] = low[node].min(index[child]);
                }
            }
            if recursed {
                continue;
            }
            if low[node] == index[node] {
                let mut component = Vec::new();
                loop {
                    let Some(popped) = stack.pop() else {
                        // The stack holds the root of every component it closes; an empty one is not a
                        // state this walk can be in, so stop the component rather than panic.
                        break;
                    };
                    on_stack[popped] = false;
                    component.push(popped);
                    if popped == node {
                        break;
                    }
                }
                if component.len() > 1 {
                    for member in component {
                        result[member] = Some(components);
                    }
                    components += 1;
                }
            }
            work.pop();
            if let Some(&(parent, _)) = work.last() {
                low[parent] = low[parent].min(low[node]);
            }
        }
    }
    (result, components)
}

/// Collapse symbol edges to file pairs and label every file node. Same-file edges and edges
/// to targets graft left unresolved are dropped; the latter are counted in meta.
fn derive(wiring: &Wiring, root: &str, build_ms: u64, signals: &Signals) -> CodeGraph {
    let mut chars: BTreeMap<&str, u64> = BTreeMap::new();
    for node in wiring.nodes.iter().filter(|node| node.kind == "file") {
        chars.insert(node.path.as_str(), node.chars);
    }
    let files: Vec<&str> = chars.keys().copied().collect();
    let position: BTreeMap<&str, usize> = files.iter().enumerate().map(|(i, f)| (*f, i)).collect();

    let mut pairs: BTreeMap<(usize, usize), bool> = BTreeMap::new();
    let mut externals: BTreeSet<&str> = BTreeSet::new();
    for edge in &wiring.edges {
        let (source, target) = (file_of(&edge.source), file_of(&edge.target));
        if source == target {
            continue;
        }
        let Some(&from) = position.get(source) else {
            continue;
        };
        let Some(&to) = position.get(target) else {
            externals.insert(target);
            continue;
        };
        let imports = pairs.entry((from, to)).or_insert(false);
        *imports |= edge.relation == "imports";
    }

    let n = files.len();
    let mut in_degree = vec![0u32; n];
    let mut out_degree = vec![0u32; n];
    let mut tested_by = vec![0u32; n];
    let mut adjacency: Vec<Vec<usize>> = vec![Vec::new(); n];
    let is_test: Vec<bool> = files.iter().map(|f| is_test_path(f)).collect();
    let mut edges = Vec::with_capacity(pairs.len());
    for (&(from, to), &imports) in &pairs {
        out_degree[from] += 1;
        in_degree[to] += 1;
        if is_test[from] && !is_test[to] {
            tested_by[to] += 1;
        }
        adjacency[from].push(to);
        edges.push(GraphEdge {
            source: files[from].to_string(),
            target: files[to].to_string(),
            relation: if imports { "imports" } else { "calls" },
        });
    }
    let (cycle_ids, cycles) = find_cycles(&adjacency);
    let cluster = cluster_of(&files);

    let nodes = files
        .iter()
        .enumerate()
        .map(|(i, path)| {
            let doc = is_doc_path(path);
            let is_test = !doc && is_test[i];
            let orphan = !doc
                && !is_test
                && in_degree[i] == 0
                && !top_dir(path).is_empty()
                && !is_entry_like(path);
            GraphNode {
                id: path.to_string(),
                name: path.rsplit('/').next().unwrap_or(path).to_string(),
                cluster: cluster(path),
                chars: chars[path],
                in_degree: in_degree[i],
                out_degree: out_degree[i],
                is_test,
                tested_by: tested_by[i],
                orphan,
                doc,
                cycle_id: cycle_ids[i],
                complexity: signals.measured.get(*path).map_or(0, |m| m.0),
                todos: signals.measured.get(*path).map_or(0, |m| m.1),
                churn: signals.churn.get(*path).copied().unwrap_or(0),
            }
        })
        .collect();

    CodeGraph {
        root: root.to_string(),
        meta: GraphMeta {
            files: n,
            edges: edges.len(),
            external_targets: externals.len(),
            cycles,
            build_ms,
        },
        nodes,
        edges,
    }
}

/// `code_graph(project, seat?)`: the file graph of the checkout, or of the seat's worktree when
/// `seat` is set, as `read_file` resolves it. Runs graft off the caller's thread.
#[tauri::command]
pub(crate) async fn code_graph(project: String, seat: Option<String>) -> Result<String, String> {
    let root = crate::source_root(&project, seat.as_deref())?;
    let response = tokio::task::spawn_blocking(move || {
        let path_env = crate::terminal_path();
        build_graph(&root, resolve_on(&path_env).as_deref(), &path_env)
    })
    .await
    .map_err(|e| format!("code_graph worker: {e}"))?;
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeSet, HashMap, HashSet};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trantor-graft-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn file(path: &str, chars: u64) -> String {
        format!(r#"{{"id":"{path}","kind":"file","path":"{path}","chars":{chars}}}"#)
    }

    fn symbol(id: &str) -> String {
        let path = file_of(id);
        format!(r#"{{"id":"{id}","kind":"function","path":"{path}"}}"#)
    }

    fn edge(source: &str, target: &str, relation: &str) -> String {
        format!(r#"{{"source":"{source}","target":"{target}","relation":"{relation}"}}"#)
    }

    /// Twelve files: a 2-cycle in lib/, an entry, a stray, a test, a doc, a root file and a
    /// container top (apps/) whose five files sit in two subdirs.
    fn fixture() -> Wiring {
        let nodes = [
            file("lib/a.ts", 100),
            file("lib/b.ts", 200),
            file("lib/stray.ts", 10),
            file("bin/cli.ts", 50),
            file("test/a.test.ts", 30),
            file("docs/README.md", 500),
            file("hub.mjs", 40),
            file("apps/web/one.ts", 1),
            file("apps/web/two.ts", 1),
            file("apps/web/three.ts", 1),
            file("apps/api/four.ts", 1),
            file("apps/api/five.ts", 1),
            symbol("lib/a.ts#run"),
            symbol("lib/b.ts#help"),
            symbol("apps/web/one.ts#f"),
            symbol("apps/api/four.ts#g"),
        ];
        let edges = [
            edge("lib/a.ts", "lib/a.ts#run", "contains"),
            edge("lib/a.ts", "lib/b.ts", "imports"),
            edge("lib/a.ts#run", "lib/b.ts#help", "calls"),
            edge("lib/b.ts", "lib/a.ts", "imports"),
            edge("bin/cli.ts", "lib/a.ts", "imports"),
            edge("apps/web/one.ts#f", "apps/api/four.ts#g", "calls"),
            edge("test/a.test.ts", "lib/a.ts", "imports"),
            edge("lib/a.ts", "node:fs", "imports"),
        ];
        let raw = format!(r#"{{"nodes":[{}],"edges":[{}]}}"#, nodes.join(","), edges.join(","));
        serde_json::from_str(&raw).unwrap()
    }

    fn node<'a>(graph: &'a CodeGraph, id: &str) -> &'a GraphNode {
        graph.nodes.iter().find(|n| n.id == id).unwrap_or_else(|| panic!("no node {id}"))
    }

    #[test]
    fn resolver_finds_graft_only_on_the_given_path() {
        let dir = temp_dir("resolve");
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        assert_eq!(resolve_on(&format!("{}:/nonexistent", bin.display())), None);
        let script = bin.join("graft");
        std::fs::write(&script, "#!/bin/sh\necho stub\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(
            resolve_on(&format!("/nonexistent::{}", bin.display())),
            Some(script.clone())
        );
        assert_eq!(resolve_on("/nonexistent:"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_binary_is_the_error_string_not_a_panic_or_an_empty_graph() {
        let dir = temp_dir("missing");
        let response = build_graph(&dir, None, "/nonexistent");
        assert_eq!(
            response,
            Response::Error {
                error: NOT_INSTALLED.to_string()
            }
        );
        let json = serde_json::to_string(&response).unwrap();
        assert_eq!(json, r#"{"error":"graft not installed"}"#);
        assert!(!json.contains("nodes"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failing_build_reports_graft_s_own_last_line() {
        let dir = temp_dir("failing");
        let script = dir.join("graft");
        std::fs::write(&script, "#!/bin/sh\necho first >&2\necho boom >&2\nexit 3\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let response = build_graph(&dir, Some(&script), "/usr/bin:/bin");
        let Response::Error { error } = response else {
            panic!("a failing build must not yield a graph")
        };
        assert!(error.starts_with("graft build failed"), "{error}");
        assert!(error.ends_with("boom"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn derive_collapses_symbol_edges_to_file_pairs_and_labels_every_node() {
        let graph = derive(&fixture(), "/repo", 7, &Signals::default());
        assert_eq!(graph.root, "/repo");
        assert_eq!(graph.meta.build_ms, 7);
        assert_eq!(graph.meta.files, 12);
        assert_eq!(graph.nodes.len(), 12);

        let mut pairs: Vec<(&str, &str, &str)> = graph
            .edges
            .iter()
            .map(|e| (e.source.as_str(), e.target.as_str(), e.relation))
            .collect();
        pairs.sort();
        assert_eq!(
            pairs,
            vec![
                ("apps/web/one.ts", "apps/api/four.ts", "calls"),
                ("bin/cli.ts", "lib/a.ts", "imports"),
                ("lib/a.ts", "lib/b.ts", "imports"),
                ("lib/b.ts", "lib/a.ts", "imports"),
                ("test/a.test.ts", "lib/a.ts", "imports"),
            ]
        );
        assert_eq!(graph.meta.edges, 5);
        assert_eq!(graph.meta.external_targets, 1, "node:fs is dropped, not a node");

        let a = node(&graph, "lib/a.ts");
        assert_eq!((a.in_degree, a.out_degree), (3, 1));
        assert_eq!(a.tested_by, 1);
        assert_eq!(a.chars, 100);
        assert_eq!(a.name, "a.ts");
        assert_eq!(a.cluster, "lib");
        assert!(!a.orphan && !a.is_test && !a.doc);
        let b = node(&graph, "lib/b.ts");
        assert_eq!((b.in_degree, b.out_degree), (1, 1));
        assert_eq!(b.tested_by, 0);

        assert_eq!(graph.meta.cycles, 1);
        assert!(a.cycle_id.is_some());
        assert_eq!(a.cycle_id, b.cycle_id);
        for n in &graph.nodes {
            if n.id != "lib/a.ts" && n.id != "lib/b.ts" {
                assert_eq!(n.cycle_id, None, "{} is not on a cycle", n.id);
            }
        }

        assert!(node(&graph, "lib/stray.ts").orphan);
        assert!(!node(&graph, "bin/cli.ts").orphan, "entry-like names are never orphans");
        let test = node(&graph, "test/a.test.ts");
        assert!(test.is_test && !test.orphan);
        let doc = node(&graph, "docs/README.md");
        assert!(doc.doc && !doc.orphan && !doc.is_test);
        let root_file = node(&graph, "hub.mjs");
        assert_eq!(root_file.cluster, "");
        assert!(!root_file.orphan, "root files are exempt from the orphan judgement");

        assert_eq!(node(&graph, "apps/web/one.ts").cluster, "apps/web");
        assert_eq!(node(&graph, "apps/api/five.ts").cluster, "apps/api");
        assert!(node(&graph, "apps/api/five.ts").orphan);

        let json = serde_json::to_string(&Response::Graph(graph)).unwrap();
        assert!(json.contains(r#""inDegree":3"#), "camelCase like the other payloads");
        assert!(json.contains(r#""cycleId":null"#));
        assert!(!json.contains("lib/a.ts#run"), "symbol nodes never cross the bridge");
    }

    #[test]
    fn test_path_heuristics_match_flare() {
        for path in [
            "test/hub.test.mjs",
            "tests/x.py",
            "a/__tests__/b.ts",
            "e2e/flow.ts",
            "src/x.spec.ts",
            "pkg/test_x.py",
            "pkg/x_test.py",
        ] {
            assert!(is_test_path(path), "{path}");
        }
        for path in ["src/testing.ts", "lib/attest.ts", "test", "src/x.test", "bin/latest_test.mjs"] {
            assert!(!is_test_path(path), "{path}");
        }
    }

    /// Independent cycle finder for the drill, by definition rather than by SCC: a node is on
    /// a cycle iff a walk from its successors reaches it again.
    fn self_reachable(adjacency: &HashMap<String, BTreeSet<String>>) -> BTreeSet<String> {
        let mut on_cycle = BTreeSet::new();
        for start in adjacency.keys() {
            let mut seen: HashSet<&str> = HashSet::new();
            let mut queue: Vec<&str> = adjacency[start].iter().map(String::as_str).collect();
            while let Some(node) = queue.pop() {
                if node == start {
                    on_cycle.insert(start.clone());
                    break;
                }
                if seen.insert(node) {
                    if let Some(next) = adjacency.get(node) {
                        queue.extend(next.iter().map(String::as_str));
                    }
                }
            }
        }
        on_cycle
    }

    fn adjacency_of(graph: &CodeGraph) -> HashMap<String, BTreeSet<String>> {
        let mut adjacency: HashMap<String, BTreeSet<String>> =
            graph.nodes.iter().map(|n| (n.id.clone(), BTreeSet::new())).collect();
        for e in &graph.edges {
            adjacency.get_mut(&e.source).unwrap().insert(e.target.clone());
        }
        adjacency
    }

    /// The card's drill on this checkout: warm answer under 2s, node count as `graft map`
    /// reports it, edge count as an independent collapse over the same wiring, PATH without
    /// graft yields the error string, and cycles trusted only after a positive control.
    #[test]
    fn drill_real_checkout_answers_warm_with_counts_that_track_graft_map() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let root = root.canonicalize().unwrap();
        let path_env = crate::terminal_path();
        let graft = resolve_on(&path_env)
            .unwrap_or_else(|| panic!("the drill needs graft on PATH ({path_env}); npm i -g @nanonets/graft"));

        let stripped = "/usr/bin:/bin";
        assert_eq!(resolve_on(stripped), None, "control: {stripped} must not carry graft");
        assert_eq!(
            build_graph(&root, resolve_on(stripped).as_deref(), stripped),
            Response::Error {
                error: NOT_INSTALLED.to_string()
            }
        );

        let control = derive(&fixture(), "/fixture", 0, &Signals::default());
        assert_eq!(control.meta.cycles, 1, "positive control: the fixture's 2-cycle is found");
        assert_eq!(
            self_reachable(&adjacency_of(&control)),
            ["lib/a.ts", "lib/b.ts"].iter().map(|s| s.to_string()).collect::<BTreeSet<_>>()
        );

        let Response::Graph(_) = build_graph(&root, Some(&graft), &path_env) else {
            panic!("warm-up build failed")
        };
        let started = Instant::now();
        let response = build_graph(&root, Some(&graft), &path_env);
        let elapsed = started.elapsed();
        let Response::Graph(graph) = response else {
            panic!("second build failed: {response:?}")
        };
        assert!(elapsed.as_millis() < 2000, "warm answer took {elapsed:?}");
        assert!(!graph.nodes.is_empty() && !graph.edges.is_empty());

        let map = std::process::Command::new(&graft)
            .args(["map", "--json", "--no-refresh", "."])
            .current_dir(&root)
            .env("PATH", &path_env)
            .output()
            .unwrap();
        assert!(map.status.success(), "{}", String::from_utf8_lossy(&map.stderr));
        let map: serde_json::Value = serde_json::from_slice(&map.stdout).unwrap();
        let files = map["totals"]["files"].as_u64().unwrap() as usize;
        assert_eq!(graph.nodes.len(), files, "node count tracks `graft map`");
        assert_eq!(graph.meta.files, files);

        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join(WIRING)).unwrap()).unwrap();
        let in_repo: HashSet<&str> = raw["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|n| n["kind"] == "file")
            .map(|n| n["path"].as_str().unwrap())
            .collect();
        let mut recount: BTreeSet<(&str, &str)> = BTreeSet::new();
        let mut independent: HashMap<String, BTreeSet<String>> =
            in_repo.iter().map(|f| (f.to_string(), BTreeSet::new())).collect();
        for e in raw["edges"].as_array().unwrap() {
            let s = file_of(e["source"].as_str().unwrap());
            let t = file_of(e["target"].as_str().unwrap());
            if s != t && in_repo.contains(s) && in_repo.contains(t) {
                recount.insert((s, t));
                independent.get_mut(s).unwrap().insert(t.to_string());
            }
        }
        assert_eq!(graph.edges.len(), recount.len(), "edge count matches an independent collapse");
        assert_eq!(graph.meta.edges, recount.len());

        let on_cycles: BTreeSet<String> = graph
            .nodes
            .iter()
            .filter(|n| n.cycle_id.is_some())
            .map(|n| n.id.clone())
            .collect();
        assert_eq!(on_cycles, self_reachable(&independent), "Tarjan agrees with self-reachability");
        if on_cycles.is_empty() {
            assert_eq!(graph.meta.cycles, 0);
        } else {
            assert!(graph.meta.cycles >= 1);
        }
        eprintln!(
            "drill: {} nodes, {} edges, {} externals, {} cycles, {:?} warm",
            graph.nodes.len(),
            graph.edges.len(),
            graph.meta.external_targets,
            graph.meta.cycles,
            elapsed
        );
    }

    const COMPLEXITY_FIXTURE: &str = include_str!("../fixtures/complexity.ts");
    /// Taken once from the Flare clone (parser.ts at 5adc94b) over the same fixture text.
    const FLARE_COMPLEXITY: u32 = 18;
    const FLARE_TODOS: u32 = 4;

    #[test]
    fn complexity_of_the_fixture_matches_flare() {
        assert_eq!(js_complexity(&strip_js_comments(COMPLEXITY_FIXTURE)), FLARE_COMPLEXITY);
        assert_eq!(complexity_of("fixtures/complexity.ts", COMPLEXITY_FIXTURE), FLARE_COMPLEXITY);
        assert_eq!(count_todos(COMPLEXITY_FIXTURE), FLARE_TODOS);
        assert_eq!(complexity_of("docs/complexity.md", COMPLEXITY_FIXTURE), 0, "prose has no complexity");
    }

    #[test]
    fn complexity_strip_blanks_strings_and_comments_and_keeps_import_specifiers_like_flare() {
        let stripped = strip_js_comments(COMPLEXITY_FIXTURE);
        let lines: Vec<&str> = stripped.lines().collect();
        assert_eq!(lines.len(), COMPLEXITY_FIXTURE.lines().count(), "line structure survives");
        assert_eq!(lines[0].trim(), "", "the header comment is spaces");
        assert!(lines[2].starts_with(r#"import { readFile } from "node:fs/promises";"#), "{}", lines[2]);
        assert_eq!(lines[3], r#"import type { Options } from "./if-options";"#);
        assert_eq!(lines[7], r#"const NOT_CODE = "                                                           ";"#);
        assert_eq!(lines[8], r#"const TEMPLATE = `      ${"   "}    ${1 ? "    " : "     "}   `;"#);
        assert!(!stripped.contains("TODO"), "a line comment is blanked");
        assert_eq!(strip_js_comments("a = 'x\\'y'; // c\nb"), "a = '    ';     \nb", "an escape blanks to two spaces");
        assert_eq!(strip_js_comments("require( 'if' )"), "require( 'if' )");
        assert_eq!(strip_js_comments("import('if')"), "import('if')");
        assert_eq!(strip_js_comments("x = f('if')"), "x = f('  ')");
    }

    #[test]
    fn complexity_counts_words_and_operators_the_way_flare_s_regexes_do() {
        assert_eq!(js_complexity("if (a && b || c) { }"), 3);
        assert_eq!(js_complexity("iffy ifs _if if_"), 0, "whole words only");
        assert_eq!(js_complexity("a?.b ?? c"), 1, "`?.` is not a ternary, `??` counts once");
        assert_eq!(js_complexity("x ? y : z"), 1);
        assert_eq!(js_complexity("let t: {w?: number}"), 0);
        assert_eq!(js_complexity("&&&"), 1);
        assert_eq!(js_complexity("||||"), 2);
        assert_eq!(js_complexity("do {} while (x) for (;;) case 1: catch (e)"), 5);
        assert_eq!(js_complexity("?"), 0, "a trailing ? has nothing after it");
        assert_eq!(py_complexity("if a and b or c:  # while\n    pass\nelif d: x\nfor i in y: z\nexcept E: w"), 6);
        assert_eq!(complexity_of("tool.py", "# if\nif x: pass"), 1);
        assert_eq!(complexity_of("src/lib.rs", "// if\nif x { } else if y { } while z { }"), 3);
        assert_eq!(count_todos("TODO FIXME HACK XXX TODOS xTODO // TODO"), 5);
    }

    #[test]
    fn complexity_todos_and_churn_ride_the_node_and_cross_the_bridge_in_camel_case() {
        let mut signals = Signals::default();
        signals.measured.insert("lib/a.ts".to_string(), (7, 2));
        signals.churn.insert("lib/a.ts".to_string(), 4);
        signals.churn.insert("not/in/graph.ts".to_string(), 9);
        let graph = derive(&fixture(), "/repo", 0, &signals);
        let a = node(&graph, "lib/a.ts");
        assert_eq!((a.complexity, a.todos, a.churn), (7, 2, 4));
        let b = node(&graph, "lib/b.ts");
        assert_eq!((b.complexity, b.todos, b.churn), (0, 0, 0));
        let json = serde_json::to_string(&Response::Graph(graph)).unwrap();
        assert!(json.contains(r#""complexity":7"#) && json.contains(r#""todos":2"#) && json.contains(r#""churn":4"#));
    }

    #[test]
    fn complexity_churn_reads_the_last_90_days_of_this_checkout() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
        let churn = git_churn(&root, &crate::terminal_path());
        let lib = churn.get("desktop/src-tauri/src/lib.rs").copied().unwrap_or(0);
        assert!(lib > 0, "lib.rs is touched in the log");
        assert!(churn.keys().all(|p| !p.starts_with('/')), "paths are relative to the root");
        let nowhere = git_churn(Path::new("/"), "/usr/bin:/bin");
        assert!(nowhere.is_empty(), "no repository is an empty map, never an error");
    }

    /// The card's drill: the Hotspots lens ranks a real hotspot first on this repo. Same warm
    /// graft build as the #7952 drill, the rank read off the node fields the lens reads.
    /// It asserts the ranker, not a filename — pinning the top file by name red-lines the day
    /// that file gets split, which is exactly how #6448 broke it (#8065).
    #[test]
    fn complexity_drill_real_checkout_ranks_a_real_hotspot_first() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
        let path_env = crate::terminal_path();
        let graft = resolve_on(&path_env)
            .unwrap_or_else(|| panic!("the drill needs graft on PATH ({path_env}); npm i -g @nanonets/graft"));
        let Response::Graph(graph) = build_graph(&root, Some(&graft), &path_env) else {
            panic!("build failed")
        };
        let hotspot = |n: &GraphNode| u64::from(n.complexity) * (u64::from(n.churn.min(50)) + 1);
        let mut ranked: Vec<&GraphNode> = graph.nodes.iter().collect();
        ranked.sort_by(|a, b| hotspot(b).cmp(&hotspot(a)).then_with(|| a.id.cmp(&b.id)));
        let top: Vec<String> = ranked
            .iter()
            .take(3)
            .map(|n| format!("{} (complexity {}, churn {}, hotspot {})", n.id, n.complexity, n.churn, hotspot(n)))
            .collect();
        eprintln!("drill hotspots: {}", top.join(" · "));
        let Some(first) = ranked.first() else {
            panic!("the ranker returned no hotspot at all on a checkout of {} files", graph.nodes.len())
        };
        assert!(hotspot(first) > 0, "the top hotspot {} scores zero — nothing ranked above the floor", first.id);
        let measured = graph.nodes.iter().filter(|n| n.complexity > 0).count();
        assert!(measured * 2 > graph.nodes.len(), "most code files carry a complexity");
    }
}
