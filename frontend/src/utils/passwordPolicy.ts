export type PasswordPolicy = {
  minLength: number;
  maxLength: number;
  requiresComplexity: boolean;
  pattern?: RegExp;
  patternHtml?: string;
  requirementsText: string;
  validationMessage: string;
};

export type PasswordRequirement = {
  id: "minLength" | "uppercase" | "lowercase" | "number" | "symbol";
  label: string;
  ok: boolean;
};

export const STRONG_PASSWORD_MESSAGE =
  "Password must be at least 12 characters and include upper, lower, number, and symbol";

export const strongPasswordPattern =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,100}$/;

export const strongPasswordPatternHtml =
  "(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[^A-Za-z0-9]).{12,100}";

export const getPasswordPolicy = (opts?: { strong?: boolean }): PasswordPolicy => {
  const strong = typeof opts?.strong === "boolean" ? opts.strong : true;
  if (strong) {
    return {
      minLength: 12,
      maxLength: 100,
      requiresComplexity: true,
      pattern: strongPasswordPattern,
      patternHtml: strongPasswordPatternHtml,
      requirementsText:
        "12-100 characters, include at least 1 uppercase letter, 1 lowercase letter, 1 number, and 1 symbol.",
      validationMessage: STRONG_PASSWORD_MESSAGE,
    };
  }

  return {
    minLength: 8,
    maxLength: 100,
    requiresComplexity: false,
    requirementsText: "8-100 characters.",
    validationMessage: "Password must be at least 8 characters long",
  };
};

export const getPasswordRequirements = (
  password: string,
  policy: PasswordPolicy
): PasswordRequirement[] => {
  const value = typeof password === "string" ? password : "";
  const requirements: PasswordRequirement[] = [
    {
      id: "minLength",
      label: `At least ${policy.minLength} characters`,
      ok: value.length >= policy.minLength,
    },
  ];

  if (policy.requiresComplexity) {
    requirements.push(
      { id: "uppercase", label: "One uppercase letter (A-Z)", ok: /[A-Z]/.test(value) },
      { id: "lowercase", label: "One lowercase letter (a-z)", ok: /[a-z]/.test(value) },
      { id: "number", label: "One number (0-9)", ok: /\d/.test(value) },
      { id: "symbol", label: "One symbol", ok: /[^A-Za-z0-9]/.test(value) }
    );
  }

  return requirements;
};

export const validatePassword = (password: string, policy: PasswordPolicy): string | null => {
  if (typeof password !== "string") return policy.validationMessage;
  if (password.length < policy.minLength) return policy.validationMessage;
  if (password.length > policy.maxLength)
    return `Password must be at most ${policy.maxLength} characters long`;
  if (policy.pattern && !policy.pattern.test(password)) return policy.validationMessage;
  return null;
};
