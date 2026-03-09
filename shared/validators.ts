export function validateEmail(email: string): boolean {
  if (!email || typeof email !== "string") {
    return false;
  }

  const trimmed = email.trim();

  // RFC 5322 simplified pattern - covers most practical cases
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  return emailRegex.test(trimmed) && trimmed.length <= 254;
}

export function validateEmailStrict(email: string): boolean {
  if (!email || typeof email !== "string") {
    return false;
  }

  const trimmed = email.trim();

  // More comprehensive RFC 5322 pattern
  const emailRegex =
    /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9]))\.){3}(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9])|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])$/i;

  return emailRegex.test(trimmed) && trimmed.length <= 254;
}

export interface EmailValidationResult {
  valid: boolean;
  error?: string;
}

export function validateEmailWithDetails(email: string): EmailValidationResult {
  if (!email) {
    return { valid: false, error: "Email address is required" };
  }

  if (typeof email !== "string") {
    return { valid: false, error: "Email must be a string" };
  }

  const trimmed = email.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: "Email address cannot be empty" };
  }

  if (trimmed.length > 254) {
    return {
      valid: false,
      error: `Email address is too long (${trimmed.length} characters, max 254)`,
    };
  }

  if (!trimmed.includes("@")) {
    return { valid: false, error: "Email address must contain an @ symbol" };
  }

  const [localPart, ...domainParts] = trimmed.split("@");

  if (domainParts.length > 1) {
    return { valid: false, error: "Email address contains multiple @ symbols" };
  }

  if (!localPart) {
    return {
      valid: false,
      error: "Email address must have content before the @ symbol",
    };
  }

  if (localPart.length > 64) {
    return {
      valid: false,
      error: `Local part is too long (${localPart.length} characters, max 64)`,
    };
  }

  const domain = domainParts[0];

  if (!domain) {
    return {
      valid: false,
      error: "Email address must have a domain after the @ symbol",
    };
  }

  if (!domain.includes(".")) {
    return {
      valid: false,
      error: "Domain must contain at least one dot (e.g., example.com)",
    };
  }

  const domainParts2 = domain.split(".");
  if (domainParts2.some((part) => !part)) {
    return {
      valid: false,
      error: "Domain contains consecutive dots or ends with a dot",
    };
  }

  const tld = domainParts2[domainParts2.length - 1];
  if (tld.length < 2) {
    return {
      valid: false,
      error: "Top-level domain must be at least 2 characters",
    };
  }

  if (!/^[a-zA-Z0-9]/.test(tld)) {
    return {
      valid: false,
      error: "Top-level domain must start with a letter or number",
    };
  }

  if (localPart.startsWith(".") || localPart.endsWith(".")) {
    return { valid: false, error: "Local part cannot start or end with a dot" };
  }

  if (/\.\./.test(localPart)) {
    return {
      valid: false,
      error: "Local part cannot contain consecutive dots",
    };
  }

  if (!/^[a-zA-Z0-9._+\-]+$/.test(localPart)) {
    return {
      valid: false,
      error:
        "Local part contains invalid characters (allowed: letters, numbers, . _ + -)",
    };
  }

  if (!/^[a-zA-Z0-9.\-]+$/.test(domain)) {
    return {
      valid: false,
      error:
        "Domain contains invalid characters (allowed: letters, numbers, . -)",
    };
  }

  if (domain.startsWith("-") || domain.endsWith("-")) {
    return {
      valid: false,
      error: "Domain labels cannot start or end with a hyphen",
    };
  }

  return { valid: true };
}

/**
 * Batch validates multiple email addresses.
 * Returns an object mapping emails to their validation results.
 */
export function validateEmails(
  emails: string[],
): Record<string, EmailValidationResult> {
  return emails.reduce(
    (acc, email) => {
      acc[email] = validateEmailWithDetails(email);
      return acc;
    },
    {} as Record<string, EmailValidationResult>,
  );
}

/**
 * Checks if an email is valid (simple boolean check).
 * Use validateEmailWithDetails() for detailed error messages.
 */
export function isValidEmail(email: string): boolean {
  const result = validateEmailWithDetails(email);
  return result.valid;
}
