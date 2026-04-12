const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const MODULE_ID = 'aufzuege';
const DEFAULT_CONFIG = { elevators: {} };

const elevatorCache = {
  config: DEFAULT_CONFIG,
  tileIndex: new Map(),
  sceneTileIndex: new Map(),
  sceneBounds: new Map()
};

function normalizeConfig(cfg) {
  const normalized = cfg && typeof cfg === "object" ? cfg : DEFAULT_CONFIG;
  normalized.elevators ??= {};
  for (const elevator of Object.values(normalized.elevators)) {
    elevator.floors ??= [];
  }
  return normalized;
}

const rebuildTileIndex = foundry.utils.debounce(_rebuildTileIndex, 50);

function _rebuildTileIndex(cfg) {
  elevatorCache.tileIndex.clear();
  elevatorCache.sceneTileIndex.clear();
  elevatorCache.sceneBounds.clear();
  for (const [elevatorId, elevator] of Object.entries(cfg.elevators)) {
    for (const floor of elevator.floors) {
      if (!floor?.tileRef) continue;
      elevatorCache.tileIndex.set(floor.tileRef, { elevatorId, elevator, floor });
      const match = /^Scene\.([^.]+)\.Tile\.([^.]+)$/.exec(floor.tileRef);
      if (!match) continue;
      const [, sceneId, tileId] = match;
      if (!sceneId || !tileId) continue;
      if (!elevatorCache.sceneTileIndex.has(sceneId)) {
        elevatorCache.sceneTileIndex.set(sceneId, new Map());
      }
      elevatorCache.sceneTileIndex.get(sceneId).set(tileId, floor.tileRef);
      const bounds = elevatorCache.sceneBounds.get(sceneId) ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      const tileDoc = game.scenes.get(sceneId)?.tiles?.get(tileId);
      if (tileDoc) {
        bounds.minX = Math.min(bounds.minX, tileDoc.x);
        bounds.minY = Math.min(bounds.minY, tileDoc.y);
        bounds.maxX = Math.max(bounds.maxX, tileDoc.x + tileDoc.width);
        bounds.maxY = Math.max(bounds.maxY, tileDoc.y + tileDoc.height);
      }
      elevatorCache.sceneBounds.set(sceneId, bounds);
    }
  }
  Hooks.callAll("aufzuegeCacheUpdated", elevatorCache);
}

export const refreshElevatorCache = foundry.utils.debounce((cfg) => {
  const normalized = normalizeConfig(foundry.utils.duplicate(cfg ?? DEFAULT_CONFIG));
  elevatorCache.config = normalized;
  rebuildTileIndex(normalized);
}, 25);

export function initializeElevatorCache() {
  const cfg = game.settings.get(MODULE_ID, "config") ?? DEFAULT_CONFIG;
  const normalized = normalizeConfig(foundry.utils.duplicate(cfg ?? DEFAULT_CONFIG));
  elevatorCache.config = normalized;
  _rebuildTileIndex(normalized);
}

export function hasElevatorsConfigured() {
  return elevatorCache.tileIndex.size > 0;
}

class ElevatorPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor({ elevatorName, floors, instruction, onSelect } = {}) {
    super({ window: { title: elevatorName } });
    this.elevatorName = elevatorName;
    this.floors = floors ?? [];
    this.instruction = instruction ?? "";
    this.onSelect = onSelect;
  }

  static get DEFAULT_OPTIONS() {
    return foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
      id: "aufzuege-elevator-dialog",
      classes: ["aufzuege-app", "aufzuege-dialog-app"],
      actions: {
        chooseFloor: ElevatorPanel.#onChooseFloor
      },
      window: {
        title: "",
        contentClasses: ["aufzuege-dialog-content"]
      }
    });
  }

  static PARTS = {
    body: {
      template: "modules/aufzuege/templates/elevator-panel.html",
      root: true
    }
  };

  async _prepareContext(options) {
    return {
      instruction: this.instruction,
      floors: this.floors.map((floor, index) => ({
        index,
        label: floor.fname ?? floor.label ?? `#${index + 1}`
      }))
    };
  }

  static #onChooseFloor(event, target) {
    const index = Number(target.dataset.index);
    const floor = this.floors?.[index];
    if (!floor) return;
    this.onSelect?.(floor);
  }
}

export function findElevatorByTile(tileRef) {
  const DEBUG = game.settings.get(MODULE_ID, "debug");
  if (DEBUG) console.log(`Aufzüge | findElevatorByTile: Checking for tileRef: ${tileRef}`);

  const match = elevatorCache.tileIndex.get(tileRef) ?? null;
  if (DEBUG) {
    if (match) console.log(`Aufzüge | findElevatorByTile: Match found! Elevator ID: ${match.elevatorId}`);
    else console.log(`Aufzüge | findElevatorByTile: No match found for ${tileRef}.`);
  }
  return match;
}

export function findElevatorByTokenBounds(tokenDoc, newX, newY) {
  const DEBUG = game.settings.get(MODULE_ID, "debug");
  const scene = canvas.scene;
  if (!scene) {
    if (DEBUG) console.log(`Aufzüge | findElevatorByTokenBounds: Scene not found on canvas.scene!`);
    return null;
  }
  if (DEBUG) console.log(`Aufzüge | findElevatorByTokenBounds: Checking scene '${scene.name}' (ID: ${scene.id})`);

  const tokenWidth = tokenDoc.width * (canvas.grid.sizeX ?? canvas.grid.w);
  const tokenHeight = tokenDoc.height * (canvas.grid.sizeY ?? canvas.grid.h);
  const tokenRect = { x: newX, y: newY, width: tokenWidth, height: tokenHeight };
  if (DEBUG) console.log(`Aufzüge | findElevatorByTokenBounds: Token's new bounding box:`, tokenRect);

  const sceneTileMap = elevatorCache.sceneTileIndex.get(scene.id);
  if (!sceneTileMap || sceneTileMap.size === 0) {
    if (DEBUG) console.log(`Aufzüge | findElevatorByTokenBounds: Scene ${scene.id} has no elevator tiles.`);
    return null;
  }

  const bounds = elevatorCache.sceneBounds.get(scene.id);
  if (bounds) {
    const overlapsBounds = !(tokenRect.x > bounds.maxX ||
      tokenRect.x + tokenRect.width < bounds.minX ||
      tokenRect.y > bounds.maxY ||
      tokenRect.y + tokenRect.height < bounds.minY);
    if (!overlapsBounds) {
      if (DEBUG) console.log(`Aufzüge | findElevatorByTokenBounds: Token outside elevator bounding box.`);
      return null;
    }
  }

  if (DEBUG) console.log(`Aufzüge | findElevatorByTokenBounds: Checking ${sceneTileMap.size} elevator tiles on scene...`);

  let foundElevator = null;
  for (const [tileId, tileRef] of sceneTileMap.entries()) {
    const tile = scene.tiles.get(tileId);
    if (!tile) continue;
    const tileRect = { x: tile.x, y: tile.y, width: tile.width, height: tile.height };
    const intersects = tokenRect.x < tileRect.x + tileRect.width &&
                       tokenRect.x + tokenRect.width > tileRect.x &&
                       tokenRect.y < tileRect.y + tileRect.height &&
                       tokenRect.y + tokenRect.height > tileRect.y;
    if (!intersects) continue;
    if (DEBUG) console.log(`Aufzüge | findElevatorByTokenBounds: Token intersects tile '${tile.id}'.`, tileRect);
    foundElevator = elevatorCache.tileIndex.get(tileRef) ?? null;
    if (foundElevator) break;
  }

  if (DEBUG) {
    if (foundElevator) console.log(`Aufzüge | findElevatorByTokenBounds: Found elevator ${foundElevator.elevatorId}.`);
    else console.log(`Aufzüge | findElevatorByTokenBounds: No intersecting elevator tiles found.`);
  }
  if (foundElevator) return foundElevator;
  return null;
}

export async function migrateTokenToScene(token, tileDoc) {
  const targetSceneId = tileDoc.parent?.id;
  if (!targetSceneId) {
    ui.notifications.warn(game.i18n.localize("AUFZUEGE.notifications.sceneNotFound"));
    return;
  }

  const centerX = tileDoc.x + tileDoc.width / 2;
  const centerY = tileDoc.y + tileDoc.height / 2;

  const targetScene = game.scenes.get(targetSceneId);
  if (!targetScene) {
    ui.notifications.warn(game.i18n.localize("AUFZUEGE.notifications.sceneNotFound"));
    return;
  }

  const isSameScene = targetSceneId === token.document.parent?.id;

  const autoPan = game.settings.get(MODULE_ID, "autoPan");

  if (isSameScene) {
    await token.document.update({ x: centerX, y: centerY, actorLink: false });
    if (autoPan) canvas.animatePan({ x: centerX, y: centerY });
  } else {
    const newTokenData = foundry.utils.duplicate(token.document.toObject());
    newTokenData.x = centerX;
    newTokenData.y = centerY;
    newTokenData.actorLink = false;

    await token.document.delete();
    await targetScene.createEmbeddedDocuments("Token", [newTokenData]);

    if (autoPan) {
      if (targetSceneId !== game.scenes.current.id) {
        await targetScene.view();
      }
      canvas.animatePan({ x: centerX, y: centerY });
    } else if (targetSceneId !== game.scenes.current.id) {
      await targetScene.view();
    }
  }

  const sound = game.settings.get(MODULE_ID, "elevatorSound");
  const volume = game.settings.get(MODULE_ID, "elevatorVolume");
  const playSoundClient = game.settings.get(MODULE_ID, "playSoundClient");
  if (sound && playSoundClient) {
    setTimeout(() => {
      foundry.audio.AudioHelper.play({ src: sound, volume: volume, autoplay: true, loop: false }, false);
    }, 500);
  }
}

export async function teleportTokenToTile(token, tileRef) {
  try {
    const tileDoc = await fromUuid(tileRef);
    if (!tileDoc) {
      ui.notifications.warn(game.i18n.localize("AUFZUEGE.notifications.tileNotFound"));
      return;
    }
    await migrateTokenToScene(token, tileDoc);
  } catch (err) {
    console.error("Aufzüge | Fehler beim Teleportieren:", err);
    ui.notifications.error(game.i18n.localize("AUFZUEGE.notifications.teleportError"));
  }
}

export function showElevatorDialog(elevatorData, token = null) {
  const DEBUG = game.settings.get(MODULE_ID, "debug");
  if (DEBUG) console.log(`Aufzüge | showElevatorDialog: Received data:`, elevatorData);

  const floors = [...(elevatorData.elevator.floors || [])];
  if (DEBUG) console.log(`Aufzüge | showElevatorDialog: Processed floors array:`, floors);

  if (floors.length < 2) {
    ui.notifications.warn(game.i18n.localize("AUFZUEGE.notifications.notEnoughFloors"));
    if (DEBUG) console.log(`Aufzüge | showElevatorDialog: Aborting, not enough floors (${floors.length}).`);
    return;
  }

  const providedTokenId = token?.id ?? token?.document?.id ?? token?._id ?? null;
  const TokenPlaceable = foundry?.canvas?.placeables?.Token ?? null;
  const isTokenPlaceable = TokenPlaceable && token instanceof TokenPlaceable;

  const resolveToken = () => {
    if (isTokenPlaceable) return token;
    if (providedTokenId) {
      const existing = canvas.tokens.get(providedTokenId);
      if (existing) return existing;
    }
    return canvas.tokens.controlled[0] ?? null;
  };

  const handleFloorSelection = async (floor) => {
    const activeToken = resolveToken();
    if (!activeToken) {
      ui.notifications.warn(game.i18n.localize("AUFZUEGE.notifications.noToken"));
      return;
    }
    try {
      await teleportTokenToTile(activeToken, floor.tileRef);
    } finally {
      panel?.close();
    }
  };

  const instruction = game.i18n.format("AUFZUEGE.dialog.selectFloor", { elevator: elevatorData.elevator.name });
  let panel;
  panel = new ElevatorPanel({
    elevatorName: elevatorData.elevator.name,
    floors,
    instruction,
    onSelect: handleFloorSelection
  });
  panel.render(true);
}
