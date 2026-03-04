/**
 * Permission modal — approve/deny destructive operations.
 * Routes responses to the correct machine that sent the request.
 */

const modal = document.getElementById("perm-modal");
const toolEl = document.getElementById("perm-tool");
const descEl = document.getElementById("perm-desc");
const approveBtn = document.getElementById("perm-approve");
const denyBtn = document.getElementById("perm-deny");
const countdownEl = document.getElementById("perm-countdown");

let multiWs = null;
let currentPermId = null;
let currentMachineUrl = null;  // Track which machine sent the permission request
let countdownInterval = null;

/** Initialize permission system */
export function initPermission(_multiWs) {
  multiWs = _multiWs;

  multiWs.on("permission_request", showPermission);

  approveBtn.addEventListener("click", () => respond(true));
  denyBtn.addEventListener("click", () => respond(false));
}

/** Show permission modal */
function showPermission(msg) {
  currentPermId = msg.permId;
  currentMachineUrl = msg._machine;  // Tagged by MultiWS with source machine URL
  toolEl.textContent = `Tool: ${msg.tool}`;
  descEl.textContent = msg.description;

  modal.classList.remove("hidden");

  // Vibrate phone
  if (navigator.vibrate) {
    navigator.vibrate([200, 100, 200]);
  }

  // Countdown
  let seconds = 60;
  countdownEl.textContent = seconds;
  clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    seconds--;
    countdownEl.textContent = seconds;
    if (seconds <= 0) {
      clearInterval(countdownInterval);
      respond(false); // Explicitly deny on timeout
    }
  }, 1000);
}

/** Send response to the correct machine and hide */
function respond(approved) {
  if (currentPermId && multiWs && currentMachineUrl) {
    multiWs.sendTo(currentMachineUrl, {
      type: "permission_response",
      permId: currentPermId,
      approved,
    });
  }
  hideModal();
}

function hideModal() {
  modal.classList.add("hidden");
  currentPermId = null;
  currentMachineUrl = null;
  clearInterval(countdownInterval);
}
