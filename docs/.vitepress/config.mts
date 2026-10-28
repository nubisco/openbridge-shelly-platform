import { defineNubiscoDocs } from '@nubisco/docs-sdk'

export default defineNubiscoDocs({
  title: 'OpenBridge Shelly Platform',
  description: 'Shelly devices over the local network, with per-phase energy telemetry and history in OpenBridge.',
  base: '/openbridge-shelly-platform/',
  hostname: 'https://docs.nubisco.io/openbridge-shelly-platform/',
  repo: 'nubisco/openbridge-shelly-platform',
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
  sidebar: {
    '/contributing': [
      {
        text: 'Contributing',
        items: [
          { text: 'How to contribute', link: '/contributing' },
          { text: 'Telemetry', link: '/telemetry' },
        ],
      },
      { text: 'Back to the guide', items: [{ text: 'Using the plugin', link: '/introduction' }] },
    ],
    '/telemetry': [
      {
        text: 'Contributing',
        items: [
          { text: 'How to contribute', link: '/contributing' },
          { text: 'Telemetry', link: '/telemetry' },
        ],
      },
      { text: 'Back to the guide', items: [{ text: 'Using the plugin', link: '/introduction' }] },
    ],
    '/': [
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
      { text: 'Help', items: [{ text: 'Troubleshooting', link: '/troubleshooting' }] },
      { text: 'Working on the plugin', items: [{ text: 'Contributing', link: '/contributing' }] },
    ],
  },
  footer: {
    message:
      'Released under the <a href="https://github.com/nubisco/openbridge-shelly-platform/blob/master/LICENSE">MIT License</a>. · <a href="https://github.com/sponsors/joseporto">♥ Sponsor this project</a>',
    copyright: 'Copyright © 2026 <a href="https://nubisco.io">Nubisco</a>',
  },
  vitepress: {
    head: [
      [
        'meta',
        {
          name: 'keywords',
          content: 'openbridge, shelly, 3em, energy, gate, garage door, homekit, plugin, smart-home',
        },
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
    ],
  },
})
