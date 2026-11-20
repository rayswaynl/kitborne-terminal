// Presentation of stored Khronos evidence only. Never reads or validates an asset.
const CAP = 8;
const SEVERITY = ['error', 'warning', 'info', 'hint'];
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;

export function createGltfReport(stored) {
  const result = {
    schema: 'asset-review/gltf-report-1', status: 'not_checked', label: 'Not checked',
    package_version: null, issues: [], omission_exact: false,
    metrics: { errors: null, warnings: null, infos: null, hints: null, total_issues: null,
      shown_messages: 0, omitted_messages: null, stored_message_cap: CAP },
    units: { errors: 'issues', warnings: 'issues', infos: 'issues', hints: 'issues', total_issues: 'issues',
      shown_messages: 'messages', omitted_messages: 'messages', stored_message_cap: 'messages' },
    assumptions: ['Saved report only; no new validation or asset budget check.',
      'Preflight keeps the first eight messages; missing info/hint totals stay unknown.'],
    diagnostics: []
  };
  let bounded = false, incomplete = false;
  // At most eight rows and 3.5 KiB of UTF-16 text per row, checked before copying.
  function text(value, limit, fallback = 'unknown') {
    if (typeof value !== 'string') { incomplete = true; return fallback; }
    if (value.length <= limit) return value;
    bounded = true; return value.slice(0, limit) + '… [text truncated]';
  }
  if (!stored || typeof stored !== 'object') {
    result.diagnostics.push('No saved Khronos report available.'); return result;
  }
  const raw = stored.issues && typeof stored.issues === 'object';
  const evidence = raw ? stored.issues : stored;
  const messages = evidence.messages;
  result.package_version = text(raw ? stored.validatorVersion : stored.version, 64);
  if (stored.available === false || (stored.status && stored.status !== 'ok')) {
    const reasons = Array.isArray(messages) ? messages.slice(0, CAP).map(m => text(typeof m === 'string' ? m : m?.message, 1024)) : [];
    const timeout = reasons.some(s => /time.?out|timed out/i.test(s));
    const budget = timeout || reasons.some(s => /exceeds|limit|budget/i.test(s));
    result.status = bounded || budget || stored.status === 'budget_exceeded' ? 'budget_exceeded' :
      stored.status === 'not_checked' ? 'not_checked' : 'unsupported';
    result.label = timeout ? 'Validator timeout' : 'Validator not available';
    result.diagnostics.push(...reasons);
    if (Array.isArray(messages) && messages.length > CAP) {
      result.status = 'budget_exceeded'; result.diagnostics.push('Diagnostics limited to eight messages.');
    }
    return result;
  }
  if (!raw && stored.available !== true) {
    result.diagnostics.push('Availability of the saved report is unknown.'); return result;
  }
  const counts = raw ? [evidence.numErrors, evidence.numWarnings, evidence.numInfos, evidence.numHints] :
    [stored.errors, stored.warnings, stored.infos, stored.hints];
  const values = counts.map(count);
  ['errors', 'warnings', 'infos', 'hints'].forEach((k, i) => { result.metrics[k] = values[i]; });
  const seen = [0, 0, 0, 0];
  if (!Array.isArray(messages)) incomplete = true;
  else {
    if (messages.length > CAP) bounded = true;
    for (let i = 0; i < Math.min(messages.length, CAP); i++) {
      const m = messages[i];
      const severity = Number.isInteger(m?.severity) && m.severity >= 0 && m.severity <= 3 ? m.severity : null;
      if (severity === null) incomplete = true; else seen[severity]++;
      result.issues.push({ code: text(m?.code, 128), severity, severity_label: SEVERITY[severity] || 'unknown',
        pointer: text(m?.pointer, 512), message: text(m?.message, 1024) });
    }
  }
  const sum = values.reduce((n, v, i) => n + (v ?? seen[i]), 0);
  const consistent = Number.isSafeInteger(sum) && values.every((v, i) => v === null || v >= seen[i]);
  const completeCounts = values.every(v => v !== null) && consistent;
  const length = Array.isArray(messages) ? messages.length : 0;
  const minimum = consistent ? Math.max(sum, length) : length;
  result.omission_exact = completeCounts && sum >= length && evidence.truncated !== true && !incomplete;
  result.metrics.total_issues = result.omission_exact ? sum : null;
  result.metrics.shown_messages = result.issues.length;
  result.metrics.omitted_messages = Math.max(0, minimum - result.issues.length);
  if (!result.omission_exact) result.diagnostics.push('Report incomplete: total and exact number of omitted messages unknown.');
  if (bounded) result.diagnostics.push('Display limited: at most eight messages and limited text length.');
  result.status = bounded ? 'budget_exceeded' : result.omission_exact ? 'ok' : 'not_checked';
  if (values[0] > 0 || seen[0]) result.label = 'Spec errors';
  else if (values[1] > 0 || seen[1]) result.label = 'Spec warnings';
  else if (!result.omission_exact || bounded) result.label = 'Spec check incomplete';
  else result.label = sum ? 'Spec information' : 'No spec issues';
  return result;
}

export function renderGltfReport(file, el) {
  if (!file || (!/\.(glb|gltf)$/i.test(file.name || '') && !file.preflight?.validator)) return null;
  const report = createGltfReport(file.preflight?.validator);
  const name = typeof file.name === 'string' ? file.name.slice(0, 256) + (file.name.length > 256 ? '… [text truncated]' : '') : 'unknown file';
  const m = report.metrics;
  const omissions = m.omitted_messages === null ? 'Omitted messages: unknown.' :
    `Omitted messages: ${report.omission_exact ? '' : 'at least '}${m.omitted_messages}${report.omission_exact ? '.' : '; exact total unknown.'}`;
  return el('section', { class: 'gltf-report', style: { overflowWrap: 'anywhere' }, 'aria-label': 'Khronos glTF spec validation', 'data-status': report.status },
    el('h3', {}, 'Khronos glTF spec validation'), el('p', {}, name + ' · ' + report.label),
    el('p', {}, 'gltf-validator package version: ' + (report.package_version || 'unknown')),
    el('p', {}, `Spec errors: ${m.errors ?? 'unknown'} · Spec warnings: ${m.warnings ?? 'unknown'}`),
    el('p', {}, 'First eight saved messages at most (top 8). ' + omissions),
    el('ol', {}, ...report.issues.map(issue => el('li', {},
      el('div', {}, `Severity: ${issue.severity_label} (${issue.severity ?? '?'}) · Code: ${issue.code}`),
      el('div', {}, 'JSON pointer: ', el('code', { style: { overflowWrap: 'anywhere' } }, issue.pointer === '' ? '"" (document root)' : issue.pointer)),
      el('p', { style: { overflowWrap: 'anywhere' } }, issue.message)))),
    ...report.diagnostics.map(d => el('p', { class: 'quiet' }, d)),
    el('p', { class: 'quiet' }, 'This report covers the glTF specification. Asset budget advice is with the existing preflight warnings.'));
}
