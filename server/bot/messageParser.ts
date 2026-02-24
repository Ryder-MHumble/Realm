/**
 * Message Parser — Parse IM messages into session targeting + prompt.
 *
 * Supports multiple targeting patterns:
 *   @Frontend fix the bug     → target "Frontend", prompt "fix the bug"
 *   Frontend: fix the bug     → target "Frontend", prompt "fix the bug"
 *   [Frontend] fix the bug    → target "Frontend", prompt "fix the bug"
 *   status                    → status query
 *   help                      → help text
 */

export interface ParsedMessage {
  /** Target session name (null = unresolved) */
  targetSessionName: string | null;
  /** The prompt text (with target prefix stripped) */
  prompt: string;
  /** Whether this is a status query */
  isStatusQuery: boolean;
  /** Whether this is a help query */
  isHelpQuery: boolean;
}

/** Escape special regex characters in a string */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Try to find a target session name at the start of the message.
 * Returns the matched session name and the remaining prompt text.
 */
function findTargetSession(
  text: string,
  sessionNames: string[],
): { name: string | null; remaining: string } {
  // Sort by length (longest first) to avoid partial matches
  // e.g., "Frontend Dev" should match before "Frontend"
  const sorted = [...sessionNames].sort((a, b) => b.length - a.length);

  for (const name of sorted) {
    const escaped = escapeRegex(name);
    const patterns = [
      // @Name prompt
      new RegExp(`^@${escaped}\\s+(.+)$`, "is"),
      // Name: prompt  or  Name：prompt (full-width colon)
      new RegExp(`^${escaped}[:\uff1a]\\s*(.+)$`, "is"),
      // [Name] prompt
      new RegExp(`^\\[${escaped}\\]\\s*(.+)$`, "is"),
      // Name prompt (space-separated, least specific — only if name has no spaces)
      ...(name.includes(" ")
        ? []
        : [new RegExp(`^${escaped}\\s+(.+)$`, "is")]),
    ];

    for (const pat of patterns) {
      const match = text.match(pat);
      if (match) {
        return { name, remaining: match[1].trim() };
      }
    }
  }

  return { name: null, remaining: text };
}

/**
 * Parse an IM message into a structured command.
 *
 * @param text - The message text (bot @mention already stripped by adapter)
 * @param sessionNames - List of current session names for matching
 */
export function parseIMMessage(
  text: string,
  sessionNames: string[],
): ParsedMessage {
  const trimmed = text.trim();

  // Check for special commands
  const lower = trimmed.toLowerCase();
  if (lower === "status" || lower === "状态") {
    return {
      targetSessionName: null,
      prompt: "",
      isStatusQuery: true,
      isHelpQuery: false,
    };
  }

  if (lower === "help" || lower === "帮助") {
    return {
      targetSessionName: null,
      prompt: "",
      isStatusQuery: false,
      isHelpQuery: true,
    };
  }

  // Try to find a target session
  const { name, remaining } = findTargetSession(trimmed, sessionNames);

  return {
    targetSessionName: name,
    prompt: remaining,
    isStatusQuery: false,
    isHelpQuery: false,
  };
}
