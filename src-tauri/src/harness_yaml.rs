//! Small, verified edits to block mappings. Unchanged YAML stays byte-for-byte
//! intact (including comments and ordering); unsupported layouts fail before IO.
use serde_json::{Map, Value};

type Result<T> = std::result::Result<T, String>;

pub fn parse(source: &str) -> Result<Value> {
    if source
        .lines()
        .all(|line| line.trim().is_empty() || line.trim_start().starts_with('#'))
    {
        return Ok(Value::Object(Map::new()));
    }
    serde_yaml_ng::from_str::<crate::pi_model_config::Strict>(source)
        .map(|v| v.0)
        .map_err(|_| "YAML 格式无效、含重复字段或不支持的标签，未写入文件".into())
}

// Locate a comment without mistaking '#' inside quoted or plain values for one.
fn comment(line: &str) -> Option<usize> {
    let mut quote = None;
    let mut escaped = false;
    let mut previous = ' ';
    for (i, c) in line.char_indices() {
        if escaped {
            escaped = false;
        } else if quote == Some('"') && c == '\\' {
            escaped = true;
        } else if quote == Some(c) {
            quote = None;
        } else if quote.is_none() {
            if (c == '\'' || c == '"') && (previous.is_whitespace() || previous == ':') {
                quote = Some(c);
            } else if c == '#' && previous.is_whitespace() {
                return Some(i);
            }
        }
        previous = c;
    }
    None
}

fn mapping_key(line: &str) -> Option<(String, usize)> {
    // Trying each delimiter also handles quoted keys containing colons.
    for (i, c) in line.char_indices() {
        if c != ':' || !line[i + 1..].starts_with(char::is_whitespace) && i + 1 != line.len() {
            continue;
        }
        if let Ok(Value::String(key)) = parse(&line[..i]) {
            return Some((key, i));
        }
    }
    None
}

pub fn update(source: &str, expected: &Value) -> Result<String> {
    let source = if source.trim() == "{}" { "" } else { source };
    let before = parse(source)?;
    if &before == expected {
        return Ok(source.to_string());
    }
    let old = before.as_object().ok_or("YAML 配置必须是对象")?;
    let new = expected.as_object().ok_or("YAML 配置必须是对象")?;
    let newline = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut lines: Vec<String> = source.split_inclusive('\n').map(str::to_string).collect();
    let mut rows = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let text = line.trim_end_matches(['\r', '\n']);
        if text.is_empty() || text.starts_with(char::is_whitespace) || text.starts_with('#') {
            continue;
        }
        if let Some((key, colon)) = mapping_key(text) {
            rows.push((i, key, colon));
        }
    }
    // Process backwards so line offsets remain stable.
    for index in (0..rows.len()).rev() {
        let (start, key, colon) = &rows[index];
        if old.get(key) == new.get(key) {
            continue;
        }
        let mut end = rows.get(index + 1).map(|r| r.0).unwrap_or(lines.len());
        // Keep comments/blank lines attached to the following entry.
        while end > start + 1
            && (lines[end - 1].trim().is_empty() || lines[end - 1].trim_start().starts_with('#'))
        {
            end -= 1;
        }
        let header = lines[*start].trim_end_matches(['\r', '\n']);
        let inline = comment(header);
        let tail = header[colon + 1..inline.unwrap_or(header.len())].trim();
        let replacement = if let Some(value) = new.get(key) {
            if old.get(key).is_some_and(Value::is_object) && value.is_object() && tail.is_empty() {
                let body = &lines[start + 1..end];
                let indent = body
                    .iter()
                    .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
                    .map(|l| l.len() - l.trim_start_matches(' ').len())
                    .min()
                    .unwrap_or(2);
                let nested: String = body
                    .iter()
                    .map(|l| {
                        if l.trim().is_empty() {
                            l.as_str()
                        } else {
                            l.get(indent..).unwrap_or(l)
                        }
                    })
                    .collect();
                let edited = update(&nested, value)?;
                let mut result = format!("{header}{newline}");
                for line in edited.split_inclusive('\n') {
                    result.push_str(&" ".repeat(indent));
                    result.push_str(line);
                }
                result
            } else if tail.is_empty()
                && old
                    .get(key)
                    .and_then(Value::as_array)
                    .zip(value.as_array())
                    .is_some_and(|(a, b)| b.starts_with(a))
            {
                let previous = old[key].as_array().unwrap();
                let next = value.as_array().unwrap();
                let indent = lines[start + 1..end]
                    .iter()
                    .find(|l| l.trim_start().starts_with("- "))
                    .map(|l| l.len() - l.trim_start_matches(' ').len())
                    .unwrap_or(2);
                let mut result = lines[*start..end].concat();
                if !result.ends_with('\n') {
                    result.push_str(newline);
                }
                for item in &next[previous.len()..] {
                    result.push_str(&format!(
                        "{}- {}{newline}",
                        " ".repeat(indent),
                        serde_json::to_string(item).map_err(|_| "无法生成 YAML 列表")?
                    ));
                }
                result
            } else {
                if lines[start + 1..end]
                    .iter()
                    .any(|line| comment(line).is_some())
                {
                    return Err("待修改 YAML 值含复杂注释，请在原应用中编辑".into());
                }
                let suffix = inline
                    .map(|i| format!(" {}", &header[i..]))
                    .unwrap_or_default();
                format!(
                    "{}: {}{suffix}{newline}",
                    &header[..*colon],
                    serde_json::to_string(value).map_err(|_| "无法生成 YAML 值")?
                )
            }
        } else {
            String::new()
        };
        lines.splice(*start..end, [replacement]);
    }
    let mut output = lines.concat();
    for (key, value) in new {
        if !old.contains_key(key) {
            if !output.is_empty() && !output.ends_with('\n') {
                output.push_str(newline);
            }
            output.push_str(&format!(
                "{}: {}{newline}",
                serde_json::to_string(key).map_err(|_| "无法生成 YAML 字段")?,
                serde_json::to_string(value).map_err(|_| "无法生成 YAML 值")?
            ));
        }
    }
    if parse(&output)? != *expected {
        return Err("YAML 布局无法保留，请在原应用中编辑，未写入文件".into());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_order_comments_crlf_and_special_strings() {
        let source = "# config\r\nz: 42\r\nproviders:\r\n  other: {key: 'a#b'} # keep\r\n  managed:\r\n    key: old # credential\r\n# next\r\na: true\r\n";
        let mut desired = parse(source).unwrap();
        desired["providers"]["managed"]["key"] = json!("!a$#&*'\"");
        desired["providers"]["managed"]["models"] = json!({"z": {}, "a": {}});
        let edited = update(source, &desired).unwrap();
        assert_eq!(parse(&edited).unwrap(), desired);
        assert!(edited.contains("other: {key: 'a#b'} # keep\r\n"));
        assert!(edited.contains("# credential\r\n"));
        assert!(edited.contains("# next\r\na: true"));
        assert!(edited.starts_with("# config\r\nz: 42"));
    }

    #[test]
    fn unsupported_layouts_and_duplicates_never_get_rewritten() {
        assert!(parse("x: 1\nx: 2\n").is_err());
        assert!(update("{x: 1}", &json!({"x": 2})).is_err());
        assert!(update("x: 1\n...\n", &json!({"x": 1, "y": 2})).is_err());
    }
}
