# Contributing to VibeIDE
### Welcome! 👋
This is the official guide on how to contribute to VibeIDE. We want to make it as easy as possible to contribute, so if you have any questions or comments, reach out via email or [Discord](https://discord.gg/NFc3EKPany)!

There are a few ways to contribute:

- 💫 Complete items on the Roadmap.
- 💡 Make suggestions in our [Discord](https://discord.gg/NFc3EKPany).
- 🪴 Start new Issues in this repository.



### Codebase Guide

We recommend reading the codebase guide in this repository if you'd like to add new features.

The repo is not as intimidating as it first seems if you read the guide!

Most VibeIDE AI code lives in the folder `src/vs/workbench/contrib/vibeide/`.



## Editing VibeIDE Code

If you're making changes to VibeIDE as a contributor, you'll want to run a local version to make sure your changes worked. Developer mode lets you do this. Here's how to use it.

### a. Mac - Prerequisites

If you're using a Mac, you need Python and XCode. You probably have these by default.

### b. Windows - Prerequisites

If you're using a Windows computer, first get [Visual Studio 2022](https://visualstudio.microsoft.com/thank-you-downloading-visual-studio/?sku=Community) (recommended) or [VS Build Tools](https://visualstudio.microsoft.com/thank-you-downloading-visual-studio/?sku=BuildTools) (not recommended). If you already have both, you might need to run the next few steps on both of them.

Go to the "Workloads" tab and select:
- `Desktop development with C++`
- `Node.js build tools`

Go to the "Individual Components" tab and select:
- `MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)`
- `C++ ATL for latest build tools with Spectre Mitigations`
- `C++ MFC for latest build tools with Spectre Mitigations`

Finally, click Install.

### c. Linux - Prerequisites

First, run `npm install -g node-gyp`. Then:

- Debian (Ubuntu, etc): `sudo apt-get install build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev python-is-python3`.
- Red Hat (Fedora, etc): `sudo dnf install @development-tools gcc gcc-c++ make libsecret-devel krb5-devel libX11-devel libxkbfile-devel`.
- SUSE (openSUSE, etc): `sudo zypper install patterns-devel-C-C++-devel_C_C++  krb5-devel libsecret-devel libxkbfile-devel libX11-devel`.
- Others: see [How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute).

### Developer Mode Instructions

Here's how to start changing VibeIDE. These steps cover everything from cloning the repo, to opening a Developer Mode window where you can play around with your updates.

1. Clone this repository.
2. `npm install` to install all dependencies.
3. Open VibeIDE or VSCode, and initialize Developer Mode (this can take ~5 min to finish, it's done when 2 of the 3 spinners turn to check marks):
   - Windows: Press <kbd>Ctrl+Shift+B</kbd>.
   - Mac: Press <kbd>Cmd+Shift+B</kbd>.
   - Linux: Press <kbd>Ctrl+Shift+B</kbd>.
4. Open the VibeIDE Developer Mode window:
   - Windows: `./scripts/code.bat`.
   - Mac: `./scripts/code.sh`.
   - Linux: `./scripts/code.sh`.
5. You're good to start editing VibeIDE!
   - You won't see your changes unless you press <kbd>Ctrl+R</kbd> (<kbd>Cmd+R</kbd>) inside the new window to reload. Alternatively, press <kbd>Ctrl+Shift+P</kbd> and `Reload Window`.
   - You might want to add the flags `--user-data-dir ./.tmp/user-data --extensions-dir ./.tmp/extensions` to the command in step 4, which lets you reset any IDE changes you made by deleting the `.tmp` folder.
	- You can kill any of the build scripts by pressing `Ctrl+D` in its terminal. If you press `Ctrl+C` the script will close but will keep running in the background.

If you get any errors, scroll down for common fixes.

#### Common Fixes

- Make sure you followed the prerequisite steps above.
- Make sure you have Node version `20.18.2` (the version in `.nvmrc`).
    - You can do this without changing your global Node version using [nvm](https://github.com/nvm-sh/nvm): run `nvm install`, followed by `nvm use` to install the version in `.nvmrc` locally.
- Make sure the path to your VibeIDE folder does not have any spaces in it.
- If you get `"TypeError: Failed to fetch dynamically imported module"`, make sure all imports end with `.js`.
- If you get an error with React, try running `NODE_OPTIONS="--max-old-space-size=8192" npm run buildreact`.
- If you see missing styles, wait a few seconds and then reload.
- If you get errors like `npm error libtool:   error: unrecognised option: '-static'`,  when running ./scripts/code.sh, make sure you have GNU libtool instead of BSD libtool (BSD is the default in macOS)
- If you get errors like `The SUID sandbox helper binary was found, but is not configured correctly` when running ./scripts/code.sh, run
`sudo chown root:root .build/electron/chrome-sandbox && sudo chmod 4755 .build/electron/chrome-sandbox` and then run `./scripts/code.sh` again.
- If you have any other questions, feel free to submit an issue in this repository. You can also refer to VSCode's complete [How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute) page.



#### Building from Terminal

To build VibeIDE from the terminal instead of from inside VSCode, follow the steps above, but instead of pressing <kbd>Cmd+Shift+B</kbd>, run `npm run watch`. The build is done when you see something like this:

```
[watch-extensions] [00:37:39] Finished compilation extensions with 0 errors after 19303 ms
[watch-client    ] [00:38:06] Finished compilation with 0 errors after 46248 ms
[watch-client    ] [00:38:07] Starting compilation...
[watch-client    ] [00:38:07] Finished compilation with 0 errors after 5 ms
```



### Distributing
We distribute VibeIDE via releases. Our build pipeline is based on VSCodium and GitHub Actions to build downloadables.

If you want to fully own a build pipeline for internal usage (not usually recommended), mirror our CI configuration and packaging steps and adjust update endpoints accordingly.


#### Building a Local Executable
We don't usually recommend building a local executable of VibeIDE—Developer Mode is faster. If you're certain, see details below.

<details>
	<summary> Building Locally (not recommended)</summary>
If you're certain you want to build a local executable of VibeIDE, follow these steps. It can take ~25 minutes.

Make sure you've already entered Developer Mode first, then run one of the following commands. This will create a folder named `VibeIDE-darwin-arm64` or similar outside of the repository (see below).


##### Mac
- `npm run gulp vscode-darwin-arm64` - most common (Apple Silicon)
- `npm run gulp vscode-darwin-x64` (Intel)

##### Windows
- `npm run gulp vscode-win32-x64` - most common
- `npm run gulp vscode-win32-arm64`

##### Linux
- `npm run gulp vscode-linux-x64` - most common
- `npm run gulp vscode-linux-arm64`


##### Local Executable Output

The local executable will be located in a folder outside of the repo folder:
```bash
workspace/
├── VibeIDE/
└── VibeIDE-darwin-arm64/ # Generated output
```

</details>


## Pull Request Guidelines


- Please submit a pull request once you've made a change.
- No need to submit an Issue unless you're creating a new feature that might involve multiple PRs.
- Please don't use AI to write your PR 🙂




