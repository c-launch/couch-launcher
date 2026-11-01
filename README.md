# Couch Launcher

A controller-first, console-style game launcher for Windows. It starts full screen when you sign in, finds your Steam and Epic games, runs Dolphin, RPCS3 and Ryujinx games, and lets you add anything else with your own artwork.

## Build it (one time)

1. Install **Node.js LTS** from https://nodejs.org if you don't have it.
2. Double-click **Build.bat**. It downloads Electron (about 100 MB) and builds the app.
3. When it's done, the `dist` folder opens with two files:
   - **Couch Launcher Setup 1.0.0.exe** installs it like a normal program (recommended, so it can start with Windows).
   - **Couch Launcher 1.0.0.exe** is portable and runs from anywhere.

To try it in a window before installing, double-click **Try it (windowed).bat** after building.

## First run

- Steam and Epic games show up on their own.
- Emulators: **Settings › Platforms**, then for each one pick the program (Dolphin.exe, rpcs3.exe, Ryujinx.exe) and your games folder. Subfolders are included.
- Anything else: **Add a game** and pick an .exe, a shortcut, or a game file.
- Themes, corner styles and accent colors: **Settings › Themes**.
- Start with Windows: **Settings › Startup & power** (on by default for the installed app).

## Controls

| Controller | Keyboard | Does |
|---|---|---|
| D-pad / left stick | Arrow keys | Move |
| A | Enter | Select / play |
| B | Esc | Back |
| Y | F2 | Edit game |
| Menu | M | Game options / power menu |
| LB / RB | Q / E | Home, Library, Settings |
| LT / RT | Page Up / Down | Jump through long lists |

**Xbox button:** opens the guide (Games, Friends, Profile & system). During a game it brings the launcher back with the guide open, where you can resume, close the game, or switch to another game. If the Xbox button doesn't work on your PC, hold **View + Menu** for 1 second instead.

- Windows opens **Xbox Game Bar** on the Xbox button too. To stop that: Windows Settings › Gaming › Xbox Game Bar › turn off "Open Xbox Game Bar using this button on a controller".
- Closing or switching games closes them the normal way, like clicking X, so games can save or ask first. For emulators to close without a pop-up, turn off **Confirm on Stop** in Dolphin (Config › Interface) and **Show "Confirm Exit" Dialog** in Ryujinx (Options › Settings › User Interface).
- RPCS3 opens its own Home menu on the Xbox/PS button, on top of the guide. To stop that: in RPCS3 open **Configuration › Devices › Gamepads** (older versions: Configuration › Gamepads), right-click the **PS Button** mapping for each player and choose to clear it (do this for every player profile you use).
- PS3 games are found in your games folder, in RPCS3's own game list, in its installed-games storage (including EmuDeck's Emulation\storage\rpcs3), and as decrypted .iso files.

**During a game (other ways back):** hold **View + Menu** for 1 second (Xbox-style controllers) or press **Ctrl + Alt + Home** to bring the launcher back, resume, or close the game. PlayStation and Switch controllers work in the launcher; the hold combo needs Steam Input or DS4Windows for them.

## Updates

Updates come online from this GitHub page (Releases). The launcher checks when it starts and every few hours (never during a game), downloads a new version in the background and asks **New version available · Update now?** It restarts by itself in a few seconds. You can also check from **Settings › About › Check for update**. An update zip saved in Downloads or G:\launcher still works too. You only need Build.bat again if a message says so.

## Guide extras

- **Home**: back to the launcher's Home if a game opens or closes wrong (the game keeps running).
- **Game / music balance**: while a game runs, slide toward the controller for more game, toward the note for more music.
- **Discord calls** (Friends tab › *Connect Discord for calls*, set up once): see who's in your call and in each pinned voice channel, join a call by pressing its pin, leave, mute and deafen. It uses Discord's own connection through a free app you make on Discord's developer page; the launcher walks you through it. Discord asks you to approve it once.
- **Discord** (Friends tab): pin channels, voice calls, servers or invites (in Discord: right-click › Copy Link, then *Pin* in the guide), open them in one press, mute/deafen, and type a message that's sent to the chat open in Discord. Mute and deafen need a one-time setup in Discord: **Settings › Keybinds › Add a Keybind**: *Toggle Mute* = Ctrl+Shift+M and *Toggle Deafen* = Ctrl+Shift+D (the guide reminds you the first time). Discord doesn't let other programs join calls, so a pin marked *Voice channel* opens the call screen with the pointer on **Join Voice**: press A. The launcher never reads or sends anything as your account on its own.

## Stores, Roblox, Microsoft Store

- **Stores** card on Home: Steam Store (in Big Picture), Xbox app (Game Pass), Microsoft Store, Epic Games Store.
- Stores, music apps, Discord and emulator setup windows open full screen on the display chosen in **Settings › Display**.
- Press the Xbox button to come back from a store and it closes (Steam leaves Big Picture). Music apps and Discord keep running. Turn this off in **Settings › Controllers**.
- Roblox and Microsoft Store / Xbox app (PC Game Pass) games are found automatically (Settings › Platforms).
- EmuDeck's Steam shortcuts aren't listed twice: when the same game is found directly through its emulator, that one is kept.

## Notes

- Your library, settings and imported artwork are stored in `%APPDATA%\Couch Launcher`.
- Dolphin, RPCS3 and Ryujinx need your own firmware, keys and game dumps.
- Player 1–4 for couch co-op are set once in each emulator's controller settings.
