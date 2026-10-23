import './styles.css'
import { App } from './app'

const root = document.getElementById('app')
if (root) {
  const app = new App(root)
  // ?debug exposes the app for automated playthroughs.
  if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { __zfs: app })
  app.start()
}
