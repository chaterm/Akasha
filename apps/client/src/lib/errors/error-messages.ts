export const ERROR_CODE_MESSAGES: Record<string, string> = {
  AUTH_INVALID_CREDENTIALS: "Email or password does not match",
  AUTH_CURRENT_PASSWORD_INCORRECT: "Current password is incorrect",
  AUTH_PASSWORD_REQUIRED: "Please enter your password to continue",
  AUTH_TOKEN_INVALID: "This link is invalid or has expired",
  AUTH_SSO_ENFORCED: "This workspace requires SSO sign-in",
  AUTH_EMAIL_DOMAIN_NOT_ALLOWED:
    "The email domain {{domain}} is not allowed in this workspace",
  AUTH_EMAIL_TAKEN: "An account with this email already exists",
  AUTH_SSO_REQUIRES_PROVIDER:
    "Enable at least one SSO provider before enforcing SSO",
  SESSION_CANNOT_REVOKE_CURRENT:
    "You cannot revoke the current session. Log out instead.",

  INVITATION_INVALID: "This invitation is invalid or has expired",
  INVITATION_ALREADY_ACCEPTED: "This invitation has already been accepted",
  MEMBER_LAST_OWNER: "The workspace must keep at least one owner",
  MEMBER_SELF_ACTION: "You cannot perform this action on yourself",
  MEMBER_OWNER_PROTECTED: "This action cannot be performed on an owner",
  MEMBER_ALREADY_DEACTIVATED: "This member is already deactivated",
  MEMBER_NOT_DEACTIVATED: "This member is not deactivated",

  GROUP_NAME_TAKEN: "A group with this name already exists",
  GROUP_DEFAULT_PROTECTED: "The default group cannot be changed",
  GROUP_MEMBER_EXISTS: "This user is already in the group",

  SPACE_SLUG_TAKEN: "This space slug is already in use",
  SPACE_LAST_ADMIN: "The space must keep at least one admin with full access",
  PERSONAL_SPACE_PROTECTED: "This cannot be changed for a personal space",

  PAGE_DELETE_REQUIRES_SPACE_ADMIN:
    "Only space admins can permanently delete pages",
  PAGE_DRAFT_LOCKED: "This draft page is locked",
  COMMENT_NOT_AUTHOR: "You can only change your own comments",
  SHARE_PUBLIC_DISABLED: "Public sharing is disabled in this workspace",
  SHARE_RESTRICTED_PAGE: "Restricted pages cannot be shared publicly.",
  TEMPLATE_NOT_APPLICABLE: "This template is not available in this space",

  FILE_TOO_LARGE: "File exceeds the {{limit}} limit",
  FILE_TYPE_INVALID: "This file type is not supported",
  EXPORT_NO_PAGES: "There are no pages you can export",
  LICENSE_REQUIRED: "This feature requires a valid license",

  API_KEY_CREATION_RESTRICTED: "Only admins can create API keys",
  API_KEY_EXPIRATION_IN_PAST: "The expiration date must be in the future",
  AGENT_NAME_TAKEN: "An agent with this name already exists",
  AGENT_SPACE_ADMIN_REQUIRED:
    "The user must be an admin of every selected space",

  AI_KNOWLEDGE_DISABLED: "The knowledge base is disabled",
  AI_GENERATIVE_DISABLED: "Generative AI is disabled",
  AI_MODEL_NOT_CONFIGURED: "The AI model is not configured",
  AI_INPUT_TOO_LONG: "Input exceeds the {{max}} character limit",
  KNOWLEDGE_ACTIVATION_FAILED:
    "Failed to enable the knowledge base. Ask an administrator to check the database setup.",
  KNOWLEDGE_PUBLISH_COOLDOWN:
    "Publishing is cooling down. Please try again later.",
  KNOWLEDGE_INDEX_MODE_LOCKED:
    "The space publish mode applies to every page in this space",
  KNOWLEDGE_SPACE_NAME_MISMATCH: "The space name you entered does not match",
  KNOWLEDGE_DELAYED_PAGE_UNAVAILABLE:
    "The page is no longer in the delayed queue, or the name you entered does not match",
  KNOWLEDGE_RUN_IN_PROGRESS:
    "A compilation run is still in progress for these pages. Try again after it finishes.",
  KNOWLEDGE_RETRY_NOT_COMPILED:
    "Only pages that have already been compiled can be retried",
  KNOWLEDGE_RETRY_PAGES_UNAVAILABLE: "Some selected pages are no longer available",
};

export const STATUS_MESSAGES: Record<number, string> = {
  403: "You don't have permission to do this",
  404: "The content you requested was not found",
  413: "The file is too large",
  429: "Too many requests. Please try again later.",
};

export const NETWORK_ERROR_MESSAGE =
  "Network error. Check your connection and try again.";
