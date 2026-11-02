//! Compatibility with canonicalObjectiveDefinition's sorted JS object + stringify.
//! Numeric property names enumerate first; other names use UTF-16 sort order.
use serde_json::Value;

fn array_index(key: &str) -> Option<u32> {
    let value = key.parse::<u32>().ok()?;
    (value != u32::MAX && value.to_string() == key).then_some(value)
}
fn write(value: &Value, depth: usize, out: &mut String) -> Result<(), String> {
    if depth > 32 {
        return Err("Quest objective definition is too deeply nested".into());
    }
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        Value::String(value) => {
            out.push_str(&serde_json::to_string(value).map_err(|e| e.to_string())?)
        }
        Value::Number(value) => {
            let value = value
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or("Invalid objective number")?;
            out.push_str(ryu_js::Buffer::new().format_finite(value));
        }
        Value::Array(values) => {
            out.push('[');
            for (i, value) in values.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(value, depth + 1, out)?;
            }
            out.push(']');
        }
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_by(|a, b| match (array_index(a), array_index(b)) {
                (Some(a), Some(b)) => a.cmp(&b),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => a.encode_utf16().cmp(b.encode_utf16()),
            });
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).map_err(|e| e.to_string())?);
                out.push(':');
                write(&values[*key], depth + 1, out)?;
            }
            out.push('}');
        }
    }
    if out.len() > 1024 * 1024 {
        return Err("Quest objective definition exceeds 1 MiB".into());
    }
    Ok(())
}
pub(crate) fn objective_definition(value: &Value) -> Result<String, String> {
    let mut out = String::new();
    write(value, 0, &mut out)?;
    Ok(out)
}
