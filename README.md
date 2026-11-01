# Couch Launcher

A controller-first, console-style game launcher for Windows. It starts full screen when you sign in, finds your Steam and Epic games, runs Dolphin, RPCS3 and Ryujinx games, and lets you add anything else with your own artwork.

## Install

1. Open this page's **Releases** (right side of the repo page) and download **CouchLauncher-Setup-<version>.exe**.
2. Run it. If Windows says "Windows protected your PC", choose **More info › Run anyway** (the installer isn't signed by a known publisher).
3. The setup wizard lets you pick the folder and shortcuts, then starts Couch Launcher.

After that it updates itself. Uninstall it from Windows' **Settings › Apps** like any program; your library and settings stay unless you delete `%APPDATA%\Couch Launcher`.

Building it yourself instead: install **Node.js LTS**, then double-click **Build.bat**; the setup file appears in `dist`. **Try it (windowed).bat** runs it in a window.

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

## Couch extras

- **Controllers**: each Xbox-style controller shows in the top bar (and guide › Profile & system) with its battery; you get a pop-up when one runs low.
- **Collections**: open a game's options (Menu button) › Collections to group games ("Party games", "Racing"...). They show in the library and on Home › Collections.
- **Steam achievements** for the selected game on Home and in the guide (needs Steam connected).
- **Alerts** when a friend comes online, someone joins or leaves your Discord call, or a Steam download finishes. Turn each off in Settings › Controllers.
- **Steam downloads**: installs and updates show a progress bar on the game's tile; new installs appear by themselves.

## Players, saves and TV settings

- **Players** (Settings › Controllers › Players, or guide › Profile & system › Set up players): everyone presses A once on their controller, in player order. Every Ryujinx, Dolphin and RPCS3 game then starts with those players, no extra screen. For Xbox-style controllers; Player 1 needs to be set up with a controller in each emulator once (your button layout is copied to the other players). The launcher keeps a backup of each emulator setting it changes (`.couch-original` / `.couch-backup` next to the file). Prefer to pick every time? Settings › Controllers › Players in emulator games › Ask every time.
- Ryujinx also gets controller profiles **Player 1–4**, copies of your setup, to load by hand if you like.
- **Dolphin saves**: closing or switching a Dolphin game makes a save state first (slot 10, so your own slot-1 save is never touched); next time you're asked whether to pick up from there. Ryujinx and RPCS3 use your in-game saves.
- **TV settings per game**: a game's options (Menu button) › TV settings: resolution, refresh rate and HDR for the chosen display, switched when the game starts and put back when it ends. Windows' own settings aren't changed, so a restart always brings your normal setup back.

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
