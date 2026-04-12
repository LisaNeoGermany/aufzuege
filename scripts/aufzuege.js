import { AufzuegeConfig } from "./config.js";
import { showElevatorDialog, findElevatorByTile, findElevatorByTokenBounds, initializeElevatorCache, refreshElevatorCache, hasElevatorsConfigured } from "./teleport.js";

const MODULE_ID = 'aufzuege';

Hooks.once("ready", () => {
  // Register settings
  game.settings.register(MODULE_ID, "config", {
    name: game.i18n.localize("AUFZUEGE.settings.config.name"),
    scope: "world",
    config: false,
    type: Object,
    default: { elevators: {} },
    onChange: value => refreshElevatorCache(value)
  });

  game.settings.registerMenu(MODULE_ID, "configMenu", {
    name: game.i18n.localize("AUFZUEGE.moduleName"),
    label: game.i18n.localize("AUFZUEGE.settings.config.label"),
    icon: "fas fa-elevator",
    type: AufzuegeConfig,
    restricted: true // GM only
  });

  game.settings.register(MODULE_ID, "elevatorSound", {
    name: game.i18n.localize("AUFZUEGE.settings.sound.name"),
    hint: game.i18n.localize("AUFZUEGE.settings.sound.hint"),
    scope: "world",
    config: true,
    type: String,
    filePicker: "audio",
    default: "modules/aufzuege/sounds/elevator-ding.ogg"
  });

  game.settings.register(MODULE_ID, "elevatorVolume", {
    name: game.i18n.localize("AUFZUEGE.settings.volume.name"),
    hint: game.i18n.localize("AUFZUEGE.settings.volume.hint"),
    scope: "world",
    config: true,
    type: Number,
    range: {
      min: 0,
      max: 1,
      step: 0.1
    },
    default: 0.8
  });

  game.settings.register(MODULE_ID, "debug", {
    name: "AUFZUEGE.settings.debug.name",
    hint: "AUFZUEGE.settings.debug.hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "autoPan", {
    name: "AUFZUEGE.settings.autoPan.name",
    hint: "AUFZUEGE.settings.autoPan.hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "playSoundClient", {
    name: "AUFZUEGE.settings.playSound.name",
    hint: "AUFZUEGE.settings.playSound.hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  // Define a public API
  game.modules.get(MODULE_ID).api = {
    /**
     * Display the elevator selection dialog for a configured tile.
     * @param {string} tileRef
     * @param {{token?: Token}} options
     */
    showMenu: (tileRef, { token } = {}) => {
      const elevatorData = findElevatorByTile(tileRef);
      if (!elevatorData) {
        ui.notifications.warn(game.i18n.localize("AUFZUEGE.notifications.noElevatorFound"));
        return;
      }
      const targetToken = token ?? canvas.tokens.controlled[0] ?? null;
      showElevatorDialog(elevatorData, targetToken);
    }
  };

  initializeElevatorCache();
  updateElevatorHooks();
  Hooks.on("aufzuegeCacheUpdated", updateElevatorHooks);
});

// Use temporary, in-memory stores for pre-update elevator status
const preUpdateElevatorStatus = new Map();
const postUpdateElevatorStatus = new Map();

let hooksRegistered = false;

export function updateElevatorHooks() {
  const hasElevators = hasElevatorsConfigured();
  if (hasElevators && !hooksRegistered) {
    Hooks.on("preUpdateToken", handlePreUpdateToken);
    Hooks.on("updateToken", handleUpdateToken);
    hooksRegistered = true;
  } else if (!hasElevators && hooksRegistered) {
    Hooks.off("preUpdateToken", handlePreUpdateToken);
    Hooks.off("updateToken", handleUpdateToken);
    hooksRegistered = false;
  }
}

function handlePreUpdateToken(tokenDoc, change, options, userId) {
  const DEBUG = game.settings.get(MODULE_ID, "debug");
  if (game.userId !== userId) return;
  if (!tokenDoc.isOwner) return;

  // Check only if position is changing
  if (!change.hasOwnProperty("x") && !change.hasOwnProperty("y")) return;

  // Check status before the update
  const wasOnElevator = findElevatorByTokenBounds(tokenDoc, tokenDoc.x, tokenDoc.y);
  if (DEBUG) console.log(`Aufzüge | preUpdateToken: Token ${tokenDoc.name} was on elevator:`, wasOnElevator);
  preUpdateElevatorStatus.set(tokenDoc.id, wasOnElevator);

  // Check status for after the update
  const newX = change.x ?? tokenDoc.x;
  const newY = change.y ?? tokenDoc.y;
  const willBeOnElevator = findElevatorByTokenBounds(tokenDoc, newX, newY);
  if (DEBUG) console.log(`Aufzüge | preUpdateToken: Token ${tokenDoc.name} will be on elevator:`, willBeOnElevator);
  postUpdateElevatorStatus.set(tokenDoc.id, willBeOnElevator);
}


function handleUpdateToken(tokenDoc, change, options, userId) {
  const DEBUG = game.settings.get(MODULE_ID, "debug");
  if (game.userId !== userId) return;
  if (!tokenDoc.isOwner) return;

  if (!change.hasOwnProperty("x") && !change.hasOwnProperty("y")) return;

  const token = canvas.tokens.get(tokenDoc.id);
  if (!token) return;

  // Clear any existing timeout to debounce the trigger
  if (token._elevatorTimeout) {
    clearTimeout(token._elevatorTimeout);
  }

  const wasOnElevator = preUpdateElevatorStatus.get(tokenDoc.id);
  const nowOnElevator = postUpdateElevatorStatus.get(tokenDoc.id);

  // Clean up maps
  preUpdateElevatorStatus.delete(tokenDoc.id);
  postUpdateElevatorStatus.delete(tokenDoc.id);

  if (DEBUG) console.log(`Aufzüge | updateToken: Token ${tokenDoc.name} is now on elevator:`, nowOnElevator);

  // Trigger condition: Token has entered a new elevator zone
  const hasEnteredElevator = nowOnElevator && (!wasOnElevator || wasOnElevator.elevatorId !== nowOnElevator.elevatorId);

  if (hasEnteredElevator) {
    if (DEBUG) console.log(`Aufzüge | updateToken: Token has entered an elevator tile. Starting 2s timer.`);
    
    token._elevatorTimeout = setTimeout(() => {
      const currentToken = canvas.tokens.get(tokenDoc.id);
      if (!currentToken) return;

      const currentElevatorData = findElevatorByTokenBounds(currentToken.document, currentToken.document.x, currentToken.document.y);
      if (DEBUG) console.log(`Aufzüge | (Delayed) Re-checking for elevator:`, currentElevatorData);

      if (currentElevatorData && currentElevatorData.elevatorId === nowOnElevator.elevatorId) {
        if (DEBUG) console.log(`Aufzüge | (Delayed) Token still on elevator. Showing dialog.`);
        showElevatorDialog(currentElevatorData, currentToken);
      } else {
        if (DEBUG) console.log(`Aufzüge | (Delayed) Token has moved off the elevator tile.`);
      }
    }, 2000);
  }
}
