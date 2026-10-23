use super::*;
/// The graph check behind `valid_graph`: every key a legal ident and
/// unique, every dependency list free of repeats and naming a key, and no
/// cycle. Malformed members fail the check rather than the evaluation.
#[doc(hidden)]
pub fn is_valid_graph(items: &[Value], key_field: &str, dependencies_field: &str) -> bool {
    let mut keys = BTreeSet::new();
    let mut edges = BTreeMap::new();
    for item in items {
        let Some(key) = item.get(key_field).and_then(Value::as_str) else {
            return false;
        };
        if !is_ident(key) || !keys.insert(key) {
            return false;
        }
        let Some(dependencies) = item.get(dependencies_field).and_then(Value::as_array) else {
            return false;
        };
        let mut named = BTreeSet::new();
        for dependency in dependencies {
            let Some(dependency) = dependency.as_str() else {
                return false;
            };
            if !named.insert(dependency) {
                return false;
            }
        }
        edges.insert(key, named);
    }
    if edges
        .values()
        .flatten()
        .any(|dependency| !keys.contains(dependency))
    {
        return false;
    }
    is_acyclic(&edges)
}
/// Kahn's algorithm over a ready queue, O(nodes + edges): whether every
/// node becomes reachable from an empty prerequisite set. Every
/// prerequisite must itself be a node.
pub(super) fn is_acyclic<K: Ord + Copy>(prerequisites: &BTreeMap<K, BTreeSet<K>>) -> bool {
    let mut waiting: BTreeMap<K, usize> = prerequisites
        .iter()
        .map(|(node, named)| (*node, named.len()))
        .collect();
    let mut dependents: BTreeMap<K, Vec<K>> = BTreeMap::new();
    for (node, named) in prerequisites {
        for prerequisite in named {
            dependents.entry(*prerequisite).or_default().push(*node);
        }
    }
    let mut ready: Vec<K> = waiting
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(node, _)| *node)
        .collect();
    let mut reached = 0usize;
    while let Some(node) = ready.pop() {
        reached += 1;
        for dependent in dependents.get(&node).map(Vec::as_slice).unwrap_or_default() {
            let count = waiting
                .get_mut(dependent)
                .expect("every dependent is a node");
            *count -= 1;
            if *count == 0 {
                ready.push(*dependent);
            }
        }
    }
    reached == prerequisites.len()
}
pub(super) fn is_ident(text: &str) -> bool {
    !text.is_empty()
        && text.chars().count() <= MAX_IDENT_CHARS
        && !text
            .chars()
            .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
}
/// The longest `ident`. Collection keys are idents taken from runtime data
/// and every id under a member embeds its key, so an unbounded ident would
/// make unbounded ids. 100 fits a GitHub repository or owner name, which
/// `pull_request.observe` carries as idents.
pub const MAX_IDENT_CHARS: usize = 100;
