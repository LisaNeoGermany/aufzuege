const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
class AufzuegeBaseApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  _updatePosition(position) {
    if (!this.element?.parentElement) return position;
    return super._updatePosition(position);
  }
}
const BaseApplication = AufzuegeBaseApplication;
const MODULE_ID = 'aufzuege';

const toJQuery = (element) => {
  if (!element) return null;
  if (element.jquery) return element;
  if (element instanceof HTMLElement || element instanceof DocumentFragment) {
    return $(element);
  }
  if (Array.isArray(element) && element[0] instanceof HTMLElement) {
    return $(element);
  }
  return null;
};

const cloneConfig = () => foundry.utils.duplicate(game.settings.get(MODULE_ID, 'config') ?? { elevators: {} });

const pendingSettingUpdate = {
  timeout: null,
  cfg: null,
  resolvers: []
};

const flushPendingUpdate = async () => {
  if (!pendingSettingUpdate.cfg) return;
  const payload = pendingSettingUpdate.cfg;
  const resolvers = pendingSettingUpdate.resolvers.splice(0);
  pendingSettingUpdate.cfg = null;
  pendingSettingUpdate.timeout = null;
  try {
    await game.settings.set(MODULE_ID, 'config', payload);
    resolvers.forEach(({ resolve }) => resolve());
  } catch (err) {
    resolvers.forEach(({ reject }) => reject(err));
  }
};

function queueConfigUpdate(mutator, { immediate = false } = {}) {
  const cfg = pendingSettingUpdate.cfg ?? cloneConfig();
  mutator(cfg);
  pendingSettingUpdate.cfg = cfg;

  return new Promise((resolve, reject) => {
    pendingSettingUpdate.resolvers.push({ resolve, reject });
    if (immediate) {
      flushPendingUpdate().catch(err => console.error(err));
      return;
    }
    if (pendingSettingUpdate.timeout) clearTimeout(pendingSettingUpdate.timeout);
    pendingSettingUpdate.timeout = setTimeout(() => {
      flushPendingUpdate().catch(err => console.error(err));
    }, 200);
  });
}

const getContent = (app) => {
  const root = app.element?.querySelector('.window-content') ?? app.element;
  return toJQuery(root);
};

const ensureElevator = (cfg, elevatorId) => {
  cfg.elevators ??= {};
  cfg.elevators[elevatorId] ??= { name: '', floors: [] };
  cfg.elevators[elevatorId].floors ??= [];
  return cfg.elevators[elevatorId];
};

export class AufzuegeConfig extends BaseApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'aufzuege-config',
      classes: ['aufzuege-app', 'aufzuege-config-app'],
      window: {
        title: game.i18n.localize("AUFZUEGE.config.window.title"),
        icon: 'fas fa-elevator',
        resizable: true,
        contentClasses: ['aufzuege-config-content']
      },
      position: {
        width: 600,
        height: 'auto'
      }
    });
  }

  static PARTS = {
    body: {
      id: 'aufzuege-config-part',
      template: 'modules/aufzuege/templates/config.html',
      root: true,
      scrollable: ['']
    }
  };

  async _prepareContext() {
    const cfg = game.settings.get(MODULE_ID, 'config') ?? { elevators: {} };
    const elevators = Object.entries(cfg.elevators).map(([id, data]) => ({ _id: id, ...data }));
    return {
      isDetail: false,
      elevators,
      total: elevators.length,
      hasElevators: elevators.length > 0
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const $html = getContent(this);
    if (!$html) return;

    $html.find('#new-elevator').off('click').on('click', async (ev) => {
      ev.preventDefault();
      const newId = foundry.utils.randomID();
      await queueConfigUpdate(cfg => {
        ensureElevator(cfg, newId);
      }, { immediate: true });
      await this.render(true);
      new AufzuegeDetailConfig({ elevatorId: newId }).render(true);
    });

    $html.find('.edit-elevator').off('click').on('click', (ev) => {
      ev.preventDefault();
      const eid = ev.currentTarget.dataset.id;
      new AufzuegeDetailConfig({ elevatorId: eid }).render(true);
    });

    $html.find('.del-elevator').off('click').on('click', async (ev) => {
      ev.preventDefault();
      const eid = ev.currentTarget.dataset.id;
      await queueConfigUpdate(cfg => {
        if (cfg.elevators?.[eid]) delete cfg.elevators[eid];
      }, { immediate: true });
      await this.render(true);
    });

    $html.find('.close-dialog').off('click').on('click', async (ev) => {
      ev.preventDefault();
      await this.close();
    });
  }
}

export class AufzuegeDetailConfig extends BaseApplication {
  constructor(options = {}) {
    super(options);
    this.elevatorId = options.elevatorId;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'aufzuege-detail',
      classes: ['aufzuege-app', 'aufzuege-detail-app'],
      window: {
        title: game.i18n.localize("AUFZUEGE.detail.window.title"),
        icon: 'fas fa-elevator',
        resizable: true,
        contentClasses: ['aufzuege-detail-content']
      },
      position: {
        width: 600,
        height: 'auto'
      }
    });
  }

  static PARTS = {
    body: {
      id: 'aufzuege-detail-part',
      template: 'modules/aufzuege/templates/config.html',
      root: true,
      scrollable: ['']
    }
  };

  async _prepareContext() {
    const cfg = game.settings.get(MODULE_ID, 'config') ?? { elevators: {} };
    const elev = cfg.elevators?.[this.elevatorId] ?? { name: '', floors: [] };
    return {
      isDetail: true,
      elevatorId: this.elevatorId,
      name: elev.name ?? '',
      floors: elev.floors ?? [],
      floorCount: (elev.floors ?? []).length
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const $html = getContent(this);
    if (!$html) return;

    $html.find('#elevator-name').off('change').on('change', async (ev) => {
      await queueConfigUpdate(cfg => {
        ensureElevator(cfg, this.elevatorId).name = ev.currentTarget.value;
      });
    });

    $html.find('#add-floor').off('click').on('click', async (ev) => {
      ev.preventDefault();
      await queueConfigUpdate(cfg => {
        const elevator = ensureElevator(cfg, this.elevatorId);
        elevator.floors.push({ fname: game.i18n.localize("AUFZUEGE.detail.newFloorName"), tileRef: '' });
      }, { immediate: true });
      await this.render(true);
    });

    $html.find('.del-floor').off('click').on('click', async (ev) => {
      ev.preventDefault();
      const idx = Number(ev.currentTarget.dataset.idx);
      await queueConfigUpdate(cfg => {
        const elevator = ensureElevator(cfg, this.elevatorId);
        if (Number.isInteger(idx)) elevator.floors.splice(idx, 1);
      }, { immediate: true });
      await this.render(true);
    });

    $html.find('.floor-field').off('change').on('change', async (ev) => {
      const idx = Number(ev.currentTarget.dataset.idx);
      const field = ev.currentTarget.dataset.field;
      const value = ev.currentTarget.value;
      await queueConfigUpdate(cfg => {
        const elevator = ensureElevator(cfg, this.elevatorId);
        if (Number.isInteger(idx) && elevator.floors[idx]) {
          elevator.floors[idx][field] = value;
        }
      });
    });

    $html.find('#delete-elevator').off('click').on('click', async (ev) => {
      ev.preventDefault();
      if (!confirm(game.i18n.localize("AUFZUEGE.detail.confirmDelete"))) return;
      await queueConfigUpdate(cfg => {
        delete cfg.elevators?.[this.elevatorId];
      }, { immediate: true });
      this.close();
      new AufzuegeConfig().render(true);
    });

    $html.find('#save-button').off('click').on('click', async (ev) => {
      ev.preventDefault();
      await this.#persistName($html);
      ui.notifications.info(game.i18n.localize("AUFZUEGE.notifications.elevatorSaved"));
      this.close();
      new AufzuegeConfig().render(true);
    });

    $html.find('.close-dialog').off('click').on('click', async (ev) => {
      ev.preventDefault();
      await this.close();
    });
  }

  async #persistName($html) {
    const name = $html.find('#elevator-name').val() ?? '';
    await queueConfigUpdate(cfg => {
      const elevator = ensureElevator(cfg, this.elevatorId);
      elevator.name = name;
    }, { immediate: true });
  }
}
