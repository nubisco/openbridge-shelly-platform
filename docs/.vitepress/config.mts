import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'OpenBridge Shelly Platform',
  description: 'Shelly devices over the local network, with per-phase energy telemetry and history in OpenBridge.',

  base: '/openbridge-shelly-platform/',

  head: [
    ['link', { rel: 'icon', href: '/openbridge-shelly-platform/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#7c3aed' }],
    ['meta', { name: 'keywords', content: 'openbridge, shelly, 3em, energy, homekit, plugin, smart-home' }],
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
    nav: [
      { text: 'Guide', link: '/introduction' },
      { text: 'Configuration', link: '/configuration' },
      {
        text: 'Links',
        items: [
          { text: 'npm', link: 'https://www.npmjs.com/package/@nubisco/openbridge-shelly-platform' },
          { text: 'GitHub', link: 'https://github.com/nubisco/openbridge-shelly-platform' },
        ],
      },
    ],

    sidebar: [
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
          { text: 'Examples', link: '/config-example' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Telemetry', link: '/telemetry' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
      {
        text: 'Community',
        items: [{ text: 'Contributing', link: '/contributing' }],
      },
    ],

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
      message: 'Released under the MIT License.',
      copyright: 'Copyright 2026 Nubisco',
    },
  },
})
