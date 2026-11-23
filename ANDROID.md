# Android app and Play Store release

The Android app is the same React app as the website, wrapped with [Capacitor](https://capacitorjs.com).
It lives in `web/android` and talks to the deployed server over HTTPS.

| Piece | Where |
| --- | --- |
| App config (id, name) | `web/capacitor.config.json` |
| Server URL for the app | `web/.env.production` (`VITE_API_URL`) |
| Android project | `web/android` (open in Android Studio) |
| Icon and splash source | `web/assets/icon.svg`, re-render with `node assets/render.mjs` |
| Privacy policy / account deletion page | `https://<your-server>/privacy` (and `#delete`) |

How the app differs from the website:

- It signs in with a bearer token kept in native storage, not a cookie, because it runs on `https://localhost` and calls the server on another origin. The server allows that origin through `APP_ORIGINS`.
- Linking defaults to the **pairing code**: you can't scan a QR code shown on the same phone.
- The ⋯ menu has **Privacy policy** and **Delete account** (Play requires in-app account deletion).

> **Policy risk.** Sending goes through Baileys, an unofficial WhatsApp client. Google Play's Device and Network Abuse
> policy bans apps that use a service in a way its terms don't allow, so the listing can be rejected or removed and the
> developer account can get a strike. WhatsApp can also ban numbers. Keep WhatsApp's name and logo out of the app name,
> icon and screenshots.

## Test locally (no deploy needed)

Live reload makes the app load the Vite dev server from your PC, and Vite proxies `/api` and `/socket.io` to the local
server. No HTTPS or `VITE_API_URL` is needed, and web edits appear in the app instantly. Needs Android Studio (step 2).

1. Start Postgres and the server as in the README (`docker compose up -d`, `npm run dev` in `server/`).
2. Start Vite so other devices can reach it:

   ```powershell
   cd web
   npx vite --host 0.0.0.0 --port 5173 --strictPort
   ```

   (In PowerShell, `npm run dev -- --host` can drop the flags.) Check it prints `Network: http://<your IP>:5173`, and
   allow Node through Windows Firewall on private networks if asked. On Xiaomi phones, turn on **Install via USB** in
   Developer options, or installs fail with `INSTALL_FAILED_USER_RESTRICTED`.
3. Plug in a phone with USB debugging on (same Wi-Fi as the PC), or start an emulator from Android Studio's Device Manager.
4. Run the app against your PC's Wi-Fi IP (`ipconfig` shows it; e.g. `192.168.1.4`):

   ```powershell
   cd web
   $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
   npx cap run android --live-reload --host 192.168.1.4 --port 5173
   ```

5. In the app, link with the pairing code. Your account and its messages stay the same: the new link just replaces the
   current linked device (the old one disappears from WhatsApp's Linked devices), and the website stays signed in.

Live reload is for testing only. Before a release build, run `npm run build` and `npx cap sync android` without
`--live-reload`, so the app is bundled and uses `VITE_API_URL`.

Quicker checks without Android Studio: open http://localhost:5173 in Chrome, press F12, and switch on the device toolbar
(Ctrl+Shift+M) to see the phone layout. Native parts (token sign-in, back button, pairing-code default) only run in the app.

## 1. Deploy the server (Render)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, pick the repo. `render.yaml` creates the web service (Starter, always on) and Postgres.
3. Fill in the prompted values:
   - `SESSION_ENC_KEY`: run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep a copy: changing it unlinks everyone.
   - `CONTACT_EMAIL`: shown on the privacy page.
   - `GEMINI_API_KEY` (or another AI key): optional, enables suggestions and AI-written messages.
4. When it's live, check `https://<service>.onrender.com/api/health` returns `{"ok":true}` and `/privacy` loads.

## 2. Set up Android Studio (once)

1. Install [Android Studio](https://developer.android.com/studio). It includes the Android SDK and a JDK (Java 25).
   The project uses Gradle 9.2.1, which supports Java 25 (Capacitor's default 8.14.3 does not).
2. Point builds at Android Studio's JDK, and tell Gradle where the SDK is (once):

   ```powershell
   $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
   "sdk.dir=$($env:LOCALAPPDATA -replace '\\','\\')\\Android\\Sdk" | Set-Content web\android\local.properties
   ```

Troubleshooting:

- **`'gradlew' is not recognized`**: the terminal has `NoDefaultCurrentDirectoryInExePath` set (terminals opened from
  some apps inherit it). Run `Remove-Item Env:NoDefaultCurrentDirectoryInExePath` in that terminal first.
- **`Gradle build daemon disappeared unexpectedly`** with an `hs_err_pid*.log` saying *insufficient memory*: Windows ran
  out of memory. Close big apps, stop dev servers you don't need, and build with `--max-workers=2`.

## 3. Build and try the app

```powershell
cd web
Copy-Item .env.production.example .env.production   # then set VITE_API_URL to your Render URL
npm run build
npx cap sync android
npx cap open android                                 # Run ▶ on a phone (USB debugging) or emulator
```

Run `npm run build` and `npx cap sync android` after every web change.

## 4. Create the upload key (once; back it up)

```powershell
cd web\android
keytool -genkeypair -v -keystore upload-key.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
Copy-Item keystore.properties.example keystore.properties   # fill in the passwords
```

`*.jks` and `keystore.properties` are git-ignored. With Play App Signing, Google holds the real signing key and this is
only your upload key, but losing it still means a support request to replace it.

## 5. Build the release bundle

```powershell
cd web\android
.\gradlew bundleRelease
```

Output: `web/android/app/build/outputs/bundle/release/app-release.aab`. For each update, raise `versionCode` (and
`versionName`) in `web/android/app/build.gradle`.

## 6. Play Console

1. Create a developer account ($25 one-off). **New personal accounts must run a closed test with at least 12 testers
   for 14 days** before they can apply for production.
2. Create the app, upload the `.aab` to a testing track first.
3. **Store listing**: name, short and full description, `web/assets/play-icon-512.png`, a 1024×500 feature graphic,
   and at least two phone screenshots.
4. **App content**:
   - Privacy policy: `https://<service>.onrender.com/privacy`
   - Account deletion: in-app (⋯ → Delete account) and web `https://<service>.onrender.com/privacy#delete`
   - Data safety: collects phone number, name, contacts (names and numbers of WhatsApp contacts), messages (text the user
     schedules; chat text for auto-reply contacts). Encrypted in transit. Users can request deletion. Not sold or shared
     for advertising. Messages and suggestion details are processed by the AI provider when AI features are used.
   - App access: reviewers need a WhatsApp account to link. Give them instructions, ideally a test number they can link with.
   - Content rating questionnaire, target audience (adults), ads: none.
