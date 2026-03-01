/**
 * VersionChecker - Checks for updates and shows a banner if outdated
 *
 * Compares the local server version (from /health) with the latest version
 * (from version.json on realm.sh). Shows a non-intrusive banner if
 * an update is available.
 */

interface VersionInfo {
  latest: string
  minSupported: string
  releaseUrl: string
  updateCommand: string
}

interface HealthResponse {
  ok: boolean
  version: string
  clients: number
  events: number
}

/**
 * Compare semantic versions. Returns:
 *  -1 if a < b
 *   0 if a === b
 *   1 if a > b
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0
    const numB = partsB[i] || 0
    if (numA < numB) return -1
    if (numA > numB) return 1
  }
  return 0
}

/**
 * Check for updates and show banner if needed
 *
 * Test modes (via query params):
 *   ?testUpdate - Show "Update Available" banner
 *   ?testUpdateCritical - Show "Update Required" banner
 */
export async function checkForUpdates(): Promise<void> {
  // Test modes for development
  const params = new URLSearchParams(window.location.search)
  if (params.has('testUpdate') || params.has('testUpdateCritical')) {
    const isCritical = params.has('testUpdateCritical')
    const fakeVersionInfo: VersionInfo = {
      latest: '99.0.0',
      minSupported: isCritical ? '99.0.0' : '0.1.0',
      releaseUrl: 'https://github.com/nearcyan/realm/releases',
      updateCommand: 'npx realm@latest setup',
    }
    console.log(`[VersionChecker] Test mode: ${isCritical ? 'critical' : 'update'} banner`)
    showUpdateBanner('0.1.0', fakeVersionInfo, isCritical)
    return
  }

  try {
    // Get server version
    const healthRes = await fetch('/health')
    if (!healthRes.ok) return

    const health: HealthResponse = await healthRes.json()
    const serverVersion = health.version

    if (!serverVersion || serverVersion === 'unknown') {
      console.log('[VersionChecker] Server version unknown, skipping check')
      return
    }

    // Get latest version info from static site
    // In dev, this will be from the local server
    // In production, it comes from realm.sh
    const versionRes = await fetch('/version.json')
    if (!versionRes.ok) {
      console.log('[VersionChecker] Could not fetch version.json')
      return
    }

    const versionInfo: VersionInfo = await versionRes.json()

    // Compare versions
    const comparison = compareVersions(serverVersion, versionInfo.latest)

    if (comparison < 0) {
      // Server is outdated
      const isUnsupported = compareVersions(serverVersion, versionInfo.minSupported) < 0
      showUpdateBanner(serverVersion, versionInfo, isUnsupported)
    } else {
      console.log(`[VersionChecker] Up to date (v${serverVersion})`)
    }
  } catch (err) {
    // Silently fail - version check is not critical
    console.log('[VersionChecker] Check failed:', err)
  }
}

/**
 * Show update banner at top of page
 */
function showUpdateBanner(
  currentVersion: string,
  versionInfo: VersionInfo,
  isUnsupported: boolean
): void {
  // Don't show multiple banners
  if (document.getElementById('version-update-banner')) return

  const banner = document.createElement('div')
  banner.id = 'version-update-banner'
  banner.className = isUnsupported ? 'version-banner version-banner-critical' : 'version-banner'

  const icon = isUnsupported ? '⚠️' : '✨'
  const title = isUnsupported ? 'Update Required' : 'Update Available'
  const message = isUnsupported
    ? `Your version (${currentVersion}) is no longer supported.`
    : `A new version is available: ${versionInfo.latest} (you have ${currentVersion})`

  banner.innerHTML = `
    <div class="version-banner-content">
      <span class="version-banner-icon">${icon}</span>
      <span class="version-banner-text">
        <strong>${title}</strong> - ${message}
      </span>
      <code class="version-banner-command">${versionInfo.updateCommand}</code>
      <a href="${versionInfo.releaseUrl}" target="_blank" class="version-banner-link">Release Notes</a>
      <button class="version-banner-dismiss" title="Dismiss">×</button>
    </div>
  `

  // Add styles
  const style = document.createElement('style')
  style.textContent = `
    .version-banner {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 10000;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      border-bottom: 1px solid #4a9eff;
      padding: 10px 20px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
      animation: slideDown 0.3s ease-out;
    }

    .version-banner-critical {
      background: linear-gradient(135deg, #2e1a1a 0%, #3e1616 100%);
      border-bottom-color: #ff4a4a;
    }

    @keyframes slideDown {
      from { transform: translateY(-100%); }
      to { transform: translateY(0); }
    }

    .version-banner-content {
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: 1400px;
      margin: 0 auto;
      flex-wrap: wrap;
    }

    .version-banner-icon {
      font-size: 18px;
    }

    .version-banner-text {
      color: #e0e0e0;
      flex: 1;
      min-width: 200px;
    }

    .version-banner-text strong {
      color: #fff;
    }

    .version-banner-command {
      background: rgba(0, 0, 0, 0.3);
      padding: 4px 10px;
      border-radius: 4px;
      color: #4a9eff;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 13px;
      user-select: all;
      cursor: pointer;
    }

    .version-banner-command:hover {
      background: rgba(0, 0, 0, 0.5);
    }

    .version-banner-critical .version-banner-command {
      color: #ff9a4a;
    }

    .version-banner-link {
      color: #4a9eff;
      text-decoration: none;
      font-size: 13px;
    }

    .version-banner-link:hover {
      text-decoration: underline;
    }

    .version-banner-critical .version-banner-link {
      color: #ff9a4a;
    }

    .version-banner-dismiss {
      background: none;
      border: none;
      color: #888;
      font-size: 20px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }

    .version-banner-dismiss:hover {
      color: #fff;
    }

    /* Push content down when banner is visible */
    body.has-version-banner {
      padding-top: 50px;
    }
  `

  document.head.appendChild(style)
  document.body.insertBefore(banner, document.body.firstChild)
  document.body.classList.add('has-version-banner')

  // Dismiss button
  const dismissBtn = banner.querySelector('.version-banner-dismiss')
  dismissBtn?.addEventListener('click', () => {
    banner.style.animation = 'slideDown 0.2s ease-in reverse'
    setTimeout(() => {
      banner.remove()
      document.body.classList.remove('has-version-banner')
    }, 200)
  })

  // Copy command on click
  const commandEl = banner.querySelector('.version-banner-command')
  commandEl?.addEventListener('click', () => {
    navigator.clipboard.writeText(versionInfo.updateCommand)
    const originalText = commandEl.textContent
    commandEl.textContent = 'Copied!'
    setTimeout(() => {
      commandEl.textContent = originalText
    }, 1500)
  })
}
