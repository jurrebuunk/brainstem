export const PERMISSIONS = [
  "dashboard:read",
  "events:read",
  "stats:read",
  "runtime:read",
  "runtime:control",
  "plugins:read",
  "plugins:manage",
  "config:read",
  "config:write",
  "users:read",
  "users:create",
  "users:update",
  "users:delete",
  "roles:read",
  "roles:manage"
];

export const DEFAULT_ROLES = [
  {
    name: "Administrator",
    description: "Full access to Brainstem operations, configuration, users, and roles.",
    system: true,
    permissions: PERMISSIONS
  },
  {
    name: "Operator",
    description: "Operate and inspect Brainstem without managing users or roles.",
    system: true,
    permissions: [
      "dashboard:read",
      "events:read",
      "stats:read",
      "runtime:read",
      "runtime:control",
      "plugins:read",
      "config:read"
    ]
  },
  {
    name: "Viewer",
    description: "Read-only access to dashboards, events, and statistics.",
    system: true,
    permissions: [
      "dashboard:read",
      "events:read",
      "stats:read",
      "runtime:read",
      "plugins:read"
    ]
  }
];

export function normalizePermissions(values) {
  const allowed = new Set(PERMISSIONS);
  return [...new Set(values ?? [])].filter(value => allowed.has(value)).sort();
}

export function hasPermission(user, permission) {
  return Boolean(user?.permissions?.includes(permission));
}
