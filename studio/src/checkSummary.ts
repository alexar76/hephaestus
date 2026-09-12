/** Turn validation spam into one or two things a human can act on. */

export interface CheckSummary {
  disconnected: string[];
  missingByNode: Record<string, string[]>;
  other: string[];
}

export function summarizeChecks(errors: string[]): CheckSummary {
  const disconnected: string[] = [];
  const missingByNode: Record<string, string[]> = {};
  const other: string[] = [];

  for (const e of errors) {
    const disc = e.match(/^"(.+)" is not connected to anything$/);
    if (disc?.[1]) {
      disconnected.push(disc[1]);
      continue;
    }
    const miss = e.match(/^"(.+)" needs "([^"]+)" \(([^)]+)\)$/);
    if (miss?.[1] && miss[2]) {
      const node = miss[1];
      const field = miss[2];
      if (!missingByNode[node]) missingByNode[node] = [];
      missingByNode[node].push(field);
      continue;
    }
    other.push(e);
  }

  return { disconnected, missingByNode, other };
}

/** Missing-field noise on loose blocks — disconnected is the real fix. */
export function checksForDisplay(errors: string[], summary: CheckSummary): string[] {
  if (summary.disconnected.length === 0) return errors;
  const loose = new Set(summary.disconnected);
  return errors.filter((e) => {
    const miss = e.match(/^"(.+)" needs "/);
    if (miss?.[1] && loose.has(miss[1])) return false;
    if (/^".+" is not connected/.test(e)) return false;
    return true;
  });
}
