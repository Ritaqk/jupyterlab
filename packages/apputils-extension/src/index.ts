/*-----------------------------------------------------------------------------
| Copyright (c) Jupyter Development Team.
| Distributed under the terms of the Modified BSD License.
|----------------------------------------------------------------------------*/

import {
  ILayoutRestorer,
  IRouter,
  JupyterLab,
  JupyterLabPlugin
} from '@jupyterlab/application';

import {
  Dialog,
  ICommandPalette,
  ISplashScreen,
  IThemeManager,
  IWindowResolver,
  ThemeManager,
  WindowResolver
} from '@jupyterlab/apputils';

import {
  ISettingRegistry,
  IStateDB,
  PageConfig,
  SettingRegistry,
  StateDB,
  URLExt
} from '@jupyterlab/coreutils';

import { IMainMenu } from '@jupyterlab/mainmenu';

import { CommandRegistry } from '@phosphor/commands';

import { PromiseDelegate } from '@phosphor/coreutils';

import { DisposableDelegate, IDisposable } from '@phosphor/disposable';

import { Menu } from '@phosphor/widgets';

import { activatePalette, restorePalette } from './palette';

import { createRedirectForm } from './redirect';

import '../style/index.css';

/**
 * The interval in milliseconds that calls to save a workspace are debounced
 * to allow for multiple quickly executed state changes to result in a single
 * workspace save operation.
 */
const WORKSPACE_SAVE_DEBOUNCE_INTERVAL = 750;

/**
 * The interval in milliseconds before recover options appear during splash.
 */
const SPLASH_RECOVER_TIMEOUT = 12000;

/**
 * The command IDs used by the apputils plugin.
 */
namespace CommandIDs {
  export const changeTheme = 'apputils:change-theme';

  export const loadState = 'apputils:load-statedb';

  export const recoverState = 'apputils:recover-statedb';

  export const reset = 'apputils:reset';

  export const resetOnLoad = 'apputils:reset-on-load';

  export const saveState = 'apputils:save-statedb';
}

/**
 * The routing regular expressions used by the apputils plugin.
 */
namespace Patterns {
  export const resetOnLoad = /(\?reset|\&reset)($|&)/;

  export const workspace = new RegExp(
    `^${PageConfig.getOption('workspacesUrl')}([^?\/]+)`
  );
}

/**
 * The default command palette extension.
 */
const palette: JupyterLabPlugin<ICommandPalette> = {
  activate: activatePalette,
  id: '@jupyterlab/apputils-extension:palette',
  provides: ICommandPalette,
  autoStart: true
};

/**
 * The default command palette's restoration extension.
 *
 * #### Notes
 * The command palette's restoration logic is handled separately from the
 * command palette provider extension because the layout restorer dependency
 * causes the command palette to be unavailable to other extensions earlier
 * in the application load cycle.
 */
const paletteRestorer: JupyterLabPlugin<void> = {
  activate: restorePalette,
  id: '@jupyterlab/apputils-extension:palette-restorer',
  requires: [ILayoutRestorer],
  autoStart: true
};

/**
 * The default setting registry provider.
 */
const settings: JupyterLabPlugin<ISettingRegistry> = {
  id: '@jupyterlab/apputils-extension:settings',
  activate: async (app: JupyterLab): Promise<ISettingRegistry> => {
    const connector = app.serviceManager.settings;
    const plugins = (await connector.list()).values;

    return new SettingRegistry({ connector, plugins });
  },
  autoStart: true,
  provides: ISettingRegistry
};

/**
 * The default theme manager provider.
 */
const themes: JupyterLabPlugin<IThemeManager> = {
  id: '@jupyterlab/apputils-extension:themes',
  requires: [ISettingRegistry, ISplashScreen],
  optional: [ICommandPalette, IMainMenu],
  activate: (
    app: JupyterLab,
    settings: ISettingRegistry,
    splash: ISplashScreen,
    palette: ICommandPalette | null,
    mainMenu: IMainMenu | null
  ): IThemeManager => {
    const host = app.shell;
    const commands = app.commands;
    const url = URLExt.join(app.info.urls.base, app.info.urls.themes);
    const key = themes.id;
    const manager = new ThemeManager({ key, host, settings, splash, url });

    // Keep a synchronously set reference to the current theme,
    // since the asynchronous setting of the theme in `changeTheme`
    // can lead to an incorrect toggle on the currently used theme.
    let currentTheme: string;

    // Set data attributes on the application shell for the current theme.
    manager.themeChanged.connect((sender, args) => {
      currentTheme = args.newValue;
      app.shell.dataset.themeLight = String(manager.isLight(currentTheme));
      app.shell.dataset.themeName = currentTheme;
      commands.notifyCommandChanged(CommandIDs.changeTheme);
    });

    commands.addCommand(CommandIDs.changeTheme, {
      label: args => {
        const theme = args['theme'] as string;
        return args['isPalette'] ? `Use ${theme} Theme` : theme;
      },
      isToggled: args => args['theme'] === currentTheme,
      execute: args => {
        const theme = args['theme'] as string;
        if (theme === manager.theme) {
          return;
        }
        manager.setTheme(theme);
      }
    });

    // If we have a main menu, add the theme manager to the settings menu.
    if (mainMenu) {
      const themeMenu = new Menu({ commands });
      themeMenu.title.label = 'JupyterLab Theme';
      app.restored.then(() => {
        const command = CommandIDs.changeTheme;
        const isPalette = false;

        manager.themes.forEach(theme => {
          themeMenu.addItem({ command, args: { isPalette, theme } });
        });
      });
      mainMenu.settingsMenu.addGroup(
        [
          {
            type: 'submenu' as Menu.ItemType,
            submenu: themeMenu
          }
        ],
        0
      );
    }

    // If we have a command palette, add theme switching options to it.
    if (palette) {
      app.restored.then(() => {
        const category = 'Settings';
        const command = CommandIDs.changeTheme;
        const isPalette = true;
        currentTheme = manager.theme;

        manager.themes.forEach(theme => {
          palette.addItem({ command, args: { isPalette, theme }, category });
        });
      });
    }

    return manager;
  },
  autoStart: true,
  provides: IThemeManager
};

/**
 * The default window name resolver provider.
 */
const resolver: JupyterLabPlugin<IWindowResolver> = {
  id: '@jupyterlab/apputils-extension:resolver',
  autoStart: true,
  provides: IWindowResolver,
  requires: [IRouter],
  activate: async (app: JupyterLab, router: IRouter) => {
    const resolver = new WindowResolver();
    const match = router.current.path.match(Patterns.workspace);
    const workspace = (match && decodeURIComponent(match[1])) || '';
    const candidate = workspace
      ? URLExt.join(
          PageConfig.getOption('baseUrl'),
          PageConfig.getOption('workspacesUrl'),
          workspace
        )
      : app.info.defaultWorkspace;

    try {
      await resolver.resolve(candidate);
    } catch (error) {
      console.warn('Window resolution failed:', error);

      // Return a promise that never resolves.
      return new Promise<IWindowResolver>(() => {
        Private.redirect(router);
      });
    }

    PageConfig.setOption('workspace', resolver.name);

    return resolver;
  }
};

/**
 * The default splash screen provider.
 */
const splash: JupyterLabPlugin<ISplashScreen> = {
  id: '@jupyterlab/apputils-extension:splash',
  autoStart: true,
  provides: ISplashScreen,
  activate: app => {
    return {
      show: (light = true) => {
        const { commands, restored } = app;

        return Private.showSplash(restored, commands, CommandIDs.reset, light);
      }
    };
  }
};

/**
 * The default state database for storing application state.
 */
const state: JupyterLabPlugin<IStateDB> = {
  id: '@jupyterlab/apputils-extension:state',
  autoStart: true,
  provides: IStateDB,
  requires: [IRouter, IWindowResolver, ISplashScreen],
  activate: (
    app: JupyterLab,
    router: IRouter,
    resolver: IWindowResolver,
    splash: ISplashScreen
  ) => {
    let debouncer: number;
    let resolved = false;

    const { commands, info, serviceManager } = app;
    const { workspaces } = serviceManager;
    const transform = new PromiseDelegate<StateDB.DataTransform>();
    const state = new StateDB({
      namespace: info.namespace,
      transform: transform.promise,
      windowName: resolver.name
    });

    commands.addCommand(CommandIDs.recoverState, {
      execute: async ({ global }) => {
        const immediate = true;
        const silent = true;

        // Clear the state silently so that the state changed signal listener
        // will not be triggered as it causes a save state.
        await state.clear(silent);

        // If the user explictly chooses to recover state, all of local storage
        // should be cleared.
        if (global) {
          try {
            window.localStorage.clear();
            console.log('Cleared local storage');
          } catch (error) {
            console.warn('Clearing local storage failed.', error);

            // To give the user time to see the console warning before redirect,
            // do not set the `immediate` flag.
            return commands.execute(CommandIDs.saveState);
          }
        }

        return commands.execute(CommandIDs.saveState, { immediate });
      }
    });

    // Conflate all outstanding requests to the save state command that happen
    // within the `WORKSPACE_SAVE_DEBOUNCE_INTERVAL` into a single promise.
    let conflated: PromiseDelegate<void> | null = null;

    commands.addCommand(CommandIDs.saveState, {
      label: () => `Save Workspace (${app.info.workspace})`,
      execute: ({ immediate }) => {
        const { workspace } = app.info;
        const timeout = immediate ? 0 : WORKSPACE_SAVE_DEBOUNCE_INTERVAL;
        const id = workspace;
        const metadata = { id };

        // Only instantiate a new conflated promise if one is not outstanding.
        if (!conflated) {
          conflated = new PromiseDelegate<void>();
        }

        if (debouncer) {
          window.clearTimeout(debouncer);
        }

        debouncer = window.setTimeout(async () => {
          // Prevent a race condition between the timeout and saving.
          if (!conflated) {
            return;
          }

          const data = await state.toJSON();

          try {
            await workspaces.save(id, { data, metadata });
            conflated.resolve(undefined);
          } catch (error) {
            conflated.reject(error);
          }
          conflated = null;
        }, timeout);

        return conflated.promise;
      }
    });

    const listener = (sender: any, change: StateDB.Change) => {
      commands.execute(CommandIDs.saveState);
    };

    commands.addCommand(CommandIDs.loadState, {
      execute: async (args: IRouter.ILocation) => {
        // Since the command can be executed an arbitrary number of times, make
        // sure it is safe to call multiple times.
        if (resolved) {
          return;
        }

        const { hash, path, search } = args;
        const { defaultWorkspace, workspace } = app.info;
        const query = URLExt.queryStringToObject(search || '');
        const clone =
          typeof query['clone'] === 'string'
            ? query['clone'] === ''
              ? defaultWorkspace
              : URLExt.join(
                  PageConfig.getOption('baseUrl'),
                  PageConfig.getOption('workspacesUrl'),
                  query['clone']
                )
            : null;
        const source = clone || workspace;

        try {
          const saved = await workspaces.fetch(source);

          // If this command is called after a reset, the state database
          // will already be resolved.
          if (!resolved) {
            resolved = true;
            transform.resolve({ type: 'overwrite', contents: saved.data });
          }
        } catch (error) {
          console.warn(`Fetching workspace (${workspace}) failed:`, error);

          // If the workspace does not exist, cancel the data transformation
          // and save a workspace with the current user state data.
          if (!resolved) {
            resolved = true;
            transform.resolve({ type: 'cancel', contents: null });
          }
        }

        // Any time the local state database changes, save the workspace.
        if (workspace) {
          state.changed.connect(
            listener,
            state
          );
        }

        const immediate = true;

        if (source === clone) {
          // Maintain the query string parameters but remove `clone`.
          delete query['clone'];

          const url = path + URLExt.objectToQueryString(query) + hash;
          const cloned = commands
            .execute(CommandIDs.saveState, { immediate })
            .then(() => router.stop);

          // After the state has been cloned, navigate to the URL.
          cloned.then(() => {
            router.navigate(url, { silent: true });
          });

          return cloned;
        }

        // After the state database has finished loading, save it.
        return commands.execute(CommandIDs.saveState, { immediate });
      }
    });

    router.register({
      command: CommandIDs.loadState,
      pattern: /.?/,
      rank: 20 // Very high priority: 20:100.
    });

    commands.addCommand(CommandIDs.reset, {
      label: 'Reset Application State',
      execute: async () => {
        const global = true;

        try {
          await commands.execute(CommandIDs.recoverState, { global });
        } catch (error) {
          /* Ignore failures and redirect. */
        }
        router.reload();
      }
    });

    commands.addCommand(CommandIDs.resetOnLoad, {
      execute: (args: IRouter.ILocation) => {
        const { hash, path, search } = args;
        const query = URLExt.queryStringToObject(search || '');
        const reset = 'reset' in query;
        const clone = 'clone' in query;

        if (!reset) {
          return;
        }

        const loading = splash.show();

        // If the state database has already been resolved, resetting is
        // impossible without reloading.
        if (resolved) {
          return router.reload();
        }

        // Empty the state database.
        resolved = true;
        transform.resolve({ type: 'clear', contents: null });

        // Maintain the query string parameters but remove `reset`.
        delete query['reset'];

        const silent = true;
        const hard = true;
        const url = path + URLExt.objectToQueryString(query) + hash;
        const cleared = commands
          .execute(CommandIDs.recoverState)
          .then(() => router.stop); // Stop routing before new route navigation.

        // After the state has been reset, navigate to the URL.
        if (clone) {
          cleared.then(() => {
            router.navigate(url, { silent, hard });
          });
        } else {
          cleared.then(() => {
            router.navigate(url, { silent });
            loading.dispose();
          });
        }

        return cleared;
      }
    });

    router.register({
      command: CommandIDs.resetOnLoad,
      pattern: Patterns.resetOnLoad,
      rank: 10 // Very high priority: 10:100.
    });

    // Clean up state database when the window unloads.
    window.addEventListener('beforeunload', () => {
      const silent = true;

      state.clear(silent).catch(() => {
        /* no-op */
      });
    });

    return state;
  }
};

/**
 * Export the plugins as default.
 */
const plugins: JupyterLabPlugin<any>[] = [
  palette,
  paletteRestorer,
  resolver,
  settings,
  state,
  splash,
  themes
];
export default plugins;

/**
 * The namespace for module private data.
 */
namespace Private {
  /**
   * Create a splash element.
   */
  function createSplash(): HTMLElement {
    const splash = document.createElement('div');
    const galaxy = document.createElement('div');
    const logo = document.createElement('div');

    splash.id = 'jupyterlab-splash';
    galaxy.id = 'galaxy';
    logo.id = 'main-logo';

    galaxy.appendChild(logo);
    ['1', '2', '3'].forEach(id => {
      const moon = document.createElement('div');
      const planet = document.createElement('div');

      moon.id = `moon${id}`;
      moon.className = 'moon orbit';
      planet.id = `planet${id}`;
      planet.className = 'planet';

      moon.appendChild(planet);
      galaxy.appendChild(moon);
    });

    splash.appendChild(galaxy);

    return splash;
  }

  /**
   * A debouncer for recovery attempts.
   */
  let debouncer = 0;

  /**
   * The recovery dialog.
   */
  let dialog: Dialog<any>;

  /**
   * Allows the user to clear state if splash screen takes too long.
   */
  function recover(fn: () => void): void {
    if (dialog) {
      return;
    }

    dialog = new Dialog({
      title: 'Loading...',
      body: `The loading screen is taking a long time.
        Would you like to clear the workspace or keep waiting?`,
      buttons: [
        Dialog.cancelButton({ label: 'Keep Waiting' }),
        Dialog.warnButton({ label: 'Clear Workspace' })
      ]
    });

    dialog
      .launch()
      .then(result => {
        if (result.button.accept) {
          return fn();
        }

        dialog.dispose();
        dialog = null;

        debouncer = window.setTimeout(() => {
          recover(fn);
        }, SPLASH_RECOVER_TIMEOUT);
      })
      .catch(() => {
        /* no-op */
      });
  }

  /**
   * Allows the user to clear state if splash screen takes too long.
   */
  export async function redirect(router: IRouter, warn = false): Promise<void> {
    const form = createRedirectForm(warn);
    const dialog = new Dialog({
      title: 'Please use a different workspace.',
      body: form,
      focusNodeSelector: 'input',
      buttons: [Dialog.okButton({ label: 'Switch Workspace' })]
    });

    const result = await dialog.launch();

    dialog.dispose();
    if (!result.value) {
      return redirect(router, true);
    }

    // Navigate to a new workspace URL and abandon this session altogether.
    const workspaces = PageConfig.getOption('workspacesUrl');
    const url = URLExt.join(workspaces, result.value);

    router.navigate(url, { hard: true, silent: true });

    // This promise will never resolve because the application navigates
    // away to a new location. It only exists to satisfy the return type
    // of the `redirect` function.
    return new Promise<void>(() => undefined);
  }

  /**
   * The splash element.
   */
  const splash = createSplash();

  /**
   * The splash screen counter.
   */
  let splashCount = 0;

  /**
   * Show the splash element.
   *
   * @param ready - A promise that must be resolved before splash disappears.
   *
   * @param commands - The application's command registry.
   *
   * @param recovery - A command that recovers from a hanging splash.
   *
   * @param light - A flag indicating whether the theme is light or dark.
   */
  export function showSplash(
    ready: Promise<any>,
    commands: CommandRegistry,
    recovery: string,
    light: boolean
  ): IDisposable {
    splash.classList.remove('splash-fade');
    splash.classList.toggle('light', light);
    splash.classList.toggle('dark', !light);
    splashCount++;

    if (debouncer) {
      window.clearTimeout(debouncer);
    }
    debouncer = window.setTimeout(() => {
      if (commands.hasCommand(recovery)) {
        recover(() => {
          commands.execute(recovery);
        });
      }
    }, SPLASH_RECOVER_TIMEOUT);

    document.body.appendChild(splash);

    return new DisposableDelegate(() => {
      ready.then(() => {
        if (--splashCount === 0) {
          if (debouncer) {
            window.clearTimeout(debouncer);
            debouncer = 0;
          }

          if (dialog) {
            dialog.dispose();
            dialog = null;
          }

          splash.classList.add('splash-fade');
          window.setTimeout(() => {
            document.body.removeChild(splash);
          }, 500);
        }
      });
    });
  }
}
