/** Prototype stakeholder roles — not authentication. */

export const ROLE = {
  ADMIN: "admin",
  TRANSPORT_AUTHORITY: "transport_authority",
  RIDE_HAILING_COMPANY: "ride_hailing_company",
};

export const ROLE_LABEL = {
  [ROLE.ADMIN]: "Admin Mode",
  [ROLE.TRANSPORT_AUTHORITY]: "Authority Mode",
  [ROLE.RIDE_HAILING_COMPANY]: "Company Mode",
};

/** Hardcoded prototype accounts — frontend demo only, not secure. */
export const PROTOTYPE_USERS = [
  {
    username: "rahaf.A",
    password: "1234",
    role: ROLE.ADMIN,
    displayName: "Rahaf",
    welcomeName: "Rahaf",
  },
  {
    username: "ghala.TA",
    password: "1234",
    role: ROLE.TRANSPORT_AUTHORITY,
    displayName: "Ghala",
    welcomeName: "Ghala",
  },
  {
    username: "remas.R",
    password: "1234",
    role: ROLE.RIDE_HAILING_COMPANY,
    displayName: "Remas",
    welcomeName: "Remas",
  },
];

const LS_ROLE = "maseer_stakeholder_role";
const LS_USERNAME = "maseer_username";
const LS_NAME = "maseer_display_name";
const LS_WELCOME = "maseer_welcome_name";

const ALL_PAGE_IDS = ["dashboard", "transport", "ops", "models", "simulation", "data"];

const ACCESS = {
  [ROLE.ADMIN]: ALL_PAGE_IDS,
  [ROLE.TRANSPORT_AUTHORITY]: ["dashboard", "transport", "models", "simulation", "data"],
  [ROLE.RIDE_HAILING_COMPANY]: ["dashboard", "ops", "models", "simulation", "data"],
};

export function isValidRole(value) {
  return value === ROLE.ADMIN || value === ROLE.TRANSPORT_AUTHORITY || value === ROLE.RIDE_HAILING_COMPANY;
}

/** First page shown after prototype login (stakeholder entry). */
export function defaultLandingPageId(role) {
  if (role === ROLE.TRANSPORT_AUTHORITY) return "transport";
  if (role === ROLE.RIDE_HAILING_COMPANY) return "ops";
  return "dashboard";
}

export function authenticatePrototype(username, password) {
  const u = String(username ?? "").trim();
  const p = String(password ?? "");
  const row = PROTOTYPE_USERS.find((x) => x.username === u && x.password === p);
  if (!row) return null;
  return {
    role: row.role,
    username: row.username,
    displayName: row.displayName,
    welcomeName: row.welcomeName,
  };
}

export function welcomeToastText({ welcomeName, role }) {
  const name = welcomeName || "User";
  if (role === ROLE.ADMIN) return `Welcome, ${name} — Admin Mode`;
  if (role === ROLE.RIDE_HAILING_COMPANY) return `Welcome, ${name} — Company Mode`;
  if (role === ROLE.TRANSPORT_AUTHORITY) return `Welcome, ${name} — Authority Mode`;
  return `Welcome, ${name}`;
}

export function readStoredSession() {
  try {
    const role = localStorage.getItem(LS_ROLE);
    const username = localStorage.getItem(LS_USERNAME) || "";
    const displayName = localStorage.getItem(LS_NAME) || "";
    const welcomeName = localStorage.getItem(LS_WELCOME) || "";
    if (!isValidRole(role) || !username.trim()) return null;
    return {
      role,
      username: username.trim(),
      displayName: displayName.trim(),
      welcomeName: welcomeName.trim() || displayName.trim(),
    };
  } catch {
    return null;
  }
}

export function persistSession({ role, username, displayName, welcomeName }) {
  try {
    if (!isValidRole(role)) return;
    localStorage.setItem(LS_ROLE, role);
    localStorage.setItem(LS_USERNAME, String(username ?? "").trim());
    localStorage.setItem(LS_NAME, String(displayName ?? "").trim());
    localStorage.setItem(LS_WELCOME, String(welcomeName ?? "").trim());
  } catch {
    /* ignore */
  }
}

export function clearStoredSession() {
  try {
    localStorage.removeItem(LS_ROLE);
    localStorage.removeItem(LS_USERNAME);
    localStorage.removeItem(LS_NAME);
    localStorage.removeItem(LS_WELCOME);
  } catch {
    /* ignore */
  }
}

/** Session-only dismiss for the regulatory alerts panel (prototype). */
export const REGULATORY_ALERTS_SESSION_HIDE_KEY = "maseer_regulatory_alerts_panel_hidden";

export function clearRegulatoryAlertsSessionHide() {
  try {
    sessionStorage.removeItem(REGULATORY_ALERTS_SESSION_HIDE_KEY);
  } catch {
    /* ignore */
  }
}

export function allowedPageIdsForRole(role) {
  if (!isValidRole(role)) return [];
  return ACCESS[role] ?? [];
}

export function canAccessPage(role, pageId) {
  return allowedPageIdsForRole(role).includes(pageId);
}
