/**
 * Machine registry — stores server list in localStorage.
 * Each machine: { name, url, token, online }
 *
 * Phone-as-hub: the phone connects directly to each server.
 */

const STORAGE_KEY = "crw-machines";
const LEGACY_TOKEN_KEY = "crw-token";

/** Load machines from localStorage */
export function loadMachines() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore corrupt data */ }
  return [];
}

/** Save machines to localStorage */
export function saveMachines(machines) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(machines));
}

/** Add a machine */
export function addMachine(name, url, token, type) {
  const machines = loadMachines();
  // Normalize URL: strip trailing slash
  const normalizedUrl = url.replace(/\/+$/, "");
  // Deduplicate by URL
  const existing = machines.findIndex((m) => m.url === normalizedUrl);
  if (existing >= 0) {
    machines[existing] = { name, url: normalizedUrl, token, online: false, type: type || "desktop" };
  } else {
    machines.push({ name, url: normalizedUrl, token, online: false, type: type || "desktop" });
  }
  saveMachines(machines);
  return machines;
}

/** Remove a machine by URL */
export function removeMachine(url) {
  const machines = loadMachines().filter((m) => m.url !== url);
  saveMachines(machines);
  return machines;
}

/** Get all machines */
export function getMachines() {
  return loadMachines();
}

/** Get a machine by name */
export function getMachineByName(name) {
  return loadMachines().find((m) => m.name === name);
}

/** Get a machine by URL */
export function getMachineByUrl(url) {
  return loadMachines().find((m) => m.url === url);
}

/**
 * Auto-migration: if old single-token auth exists and no machines configured,
 * create a single machine entry from the current origin.
 */
export function migrateFromLegacyAuth() {
  const machines = loadMachines();
  if (machines.length > 0) return false; // Already migrated

  const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY);
  if (!legacyToken) return false;

  const url = `${location.protocol}//${location.host}`;
  addMachine("this-pc", url, legacyToken);
  // Don't remove legacy token — keep for fallback
  return true;
}

/** Check if any machines are configured */
export function hasMachines() {
  return loadMachines().length > 0;
}

/** Update a machine's online status in memory (not persisted) */
export function updateMachineOnline(url, online) {
  const machines = loadMachines();
  const machine = machines.find((m) => m.url === url);
  if (machine) {
    machine.online = online;
    saveMachines(machines);
  }
}
