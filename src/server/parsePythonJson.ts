// Python's json.dumps can emit bare non-finite numeric tokens. Preserve quoted
// strings while turning those tokens into null for strict JSON consumers.
export function parsePythonJson<T = unknown>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    const normalized = text.replace(/"(?:\\.|[^"\\])*"|-?\b(?:NaN|Infinity)\b/g,
      token => token.startsWith('"') ? token : 'null');
    return JSON.parse(normalized) as T;
  } catch {
    return null;
  }
}
