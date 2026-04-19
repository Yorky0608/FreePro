import { defineConfig } from 'vite'

export default defineConfig({
  // GitHub Pages often serves your site from a subpath (e.g., /<repo>/).
  // Using a relative base keeps asset URLs working regardless of the subpath.
  base: './',
})
