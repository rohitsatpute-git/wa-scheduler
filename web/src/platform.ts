import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'

/**
 * Browser vs Android app.
 *
 * The browser app is served by the server itself, so it calls `/api` on the same origin and
 * signs in with an httpOnly cookie. The Android app is a WebView on https://localhost with the
 * web build bundled inside; it calls the server at VITE_API_URL and signs in with a bearer token
 * kept in native storage (Preferences survives WebView storage being cleared).
 */

export const APP_NAME = 'Message Scheduler'
export const isNative = Capacitor.isNativePlatform()

/**
 * '' = same origin: the browser app, or the Android app in live-reload mode (it loads the Vite dev
 * server, which proxies /api). In a release app build: the deployed server, e.g. https://your-app.onrender.com
 */
export const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/+$/, '')

// A bundled app build (served from https://localhost) has no server of its own to fall back on.
if (isNative && !API_BASE && window.location.hostname === 'localhost') {
  console.error('VITE_API_URL is not set; the app cannot reach the server')
}

const TOKEN_KEY = 'auth_token'
let token: string | null = null

export const getToken = () => token

/** Call before the first API request. */
export async function loadToken() {
  if (!isNative) return
  token = (await Preferences.get({ key: TOKEN_KEY })).value
}

export async function setToken(value: string | null) {
  token = value
  if (!isNative) return
  if (value) await Preferences.set({ key: TOKEN_KEY, value })
  else await Preferences.remove({ key: TOKEN_KEY })
}

/** A page served by the server (e.g. /privacy), from either the browser or the app. */
export const serverUrl = (path: string) => `${API_BASE || window.location.origin}${path}`
