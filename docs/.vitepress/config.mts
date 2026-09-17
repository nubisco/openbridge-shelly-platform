import { defineConfig } from 'vitepress'

/** Getting a device working: what almost every reader came for. */
const usingIt = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Introduction', link: '/introduction' },
      { text: 'Installation', link: '/installation' },
    ],
  },
  {
    text: 'Configuration',
    items: [
      { text: 'Configuration', link: '/configuration' },
      { text: 'Supported Devices', link: '/supported-devices' },
      { text: 'Gates', link: '/gates' },
      { text: 'Examples', link: '/config-example' },
    ],
  },
  {
    text: 'Help',
    items: [{ text: 'Troubleshooting', link: '/troubleshooting' }],
  },
  {
    text: 'Working on the plugin',
    items: [{ text: 'Contributing', link: '/contributing' }],
  },
]

/** Working on the plugin rather than with it. */
const contributing = [
  {
    text: 'Contributing',
    items: [
      { text: 'How to contribute', link: '/contributing' },
      { text: 'Telemetry', link: '/telemetry' },
    ],
  },
  {
    text: 'Back to the guide',
    items: [{ text: 'Using the plugin', link: '/introduction' }],
  },
]

export default defineConfig({
  title: 'OpenBridge Shelly Platform',
  description: 'Shelly devices over the local network, with per-phase energy telemetry and history in OpenBridge.',

  base: '/openbridge-shelly-platform/',

  head: [
    ['link', { rel: 'icon', href: '/openbridge-shelly-platform/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#22335e' }],
    [
      'meta',
      { name: 'keywords', content: 'openbridge, shelly, 3em, energy, gate, garage door, homekit, plugin, smart-home' },
    ],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'OpenBridge Shelly Platform' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'Shelly devices over the local network, with per-phase energy telemetry and history in OpenBridge.',
      },
    ],
    [
      'script',
      {
        defer: '',
        src: 'https://analytics.nubisco.io/script.js',
      },
    ],
  ],
  sitemap: {
    hostname: 'https://docs.nubisco.io/openbridge-shelly-platform/',
  },

  lastUpdated: true,

  themeConfig: {
    siteTitle: 'Shelly Platform',
    logo: { src: '/logo-mini.svg', width: 24, height: 24 },
    // TWO DOORS, SPLIT BY ACTIVITY, NOT PERSONA. Everyone reading this is the
    // same self-hosting person: install, JSON config, troubleshooting. A users
    // versus developers split would put a door here with nobody behind it. What
    // does differ is what you came to do, so it is getting a device working
    // versus working on the plugin. See "Documentation sites" in the workspace
    // AGENTS.md for the plugin tier.
    nav: [
      { text: 'Using it', link: '/introduction' },
      { text: 'Contributing', link: '/contributing' },
      {
        text: 'Project',
        items: [
          { text: 'Repository', link: 'https://github.com/nubisco/openbridge-shelly-platform' },
          { text: 'npm', link: 'https://www.npmjs.com/package/@nubisco/openbridge-shelly-platform' },
          {
            text: 'Contributing',
            link: 'https://github.com/nubisco/openbridge-shelly-platform/blob/master/CONTRIBUTING.md',
          },
          { text: 'Sponsor', link: 'https://github.com/sponsors/joseporto' },
        ],
      },
      {
        text: 'Nubisco',
        items: [
          { text: 'nubisco.io', link: 'https://nubisco.io' },
          { text: 'OpenBridge', link: 'https://github.com/nubisco/openbridge' },
          { text: 'Nubisco UI', link: 'https://docs.nubisco.io/ui/' },
          { text: 'Acta', link: 'https://docs.nubisco.io/acta/' },
        ],
      },
    ],

    // Every page sits at the root, so the two halves are keyed page by page
    // rather than by directory. Nothing moves, so no published URL changes.
    sidebar: {
      '/contributing': contributing,
      '/telemetry': contributing,
      '/': usingIt,
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/nubisco/openbridge-shelly-platform' }],

    editLink: {
      pattern: 'https://github.com/nubisco/openbridge-shelly-platform/edit/master/docs/:path',
      text: 'Edit this page on GitHub',
    },

    search: {
      provider: 'local',
    },

    lastUpdated: {
      text: 'Last updated',
    },

    footer: {
      message:
        'Released under the <a href="https://github.com/nubisco/openbridge-shelly-platform/blob/master/LICENSE">MIT License</a>. \u00b7 <a href="https://github.com/sponsors/joseporto">\u2665 Sponsor this project</a>',
      copyright: 'Copyright \u00a9 2026 <a href="https://nubisco.io">Nubisco</a>',
    },
  },
})
