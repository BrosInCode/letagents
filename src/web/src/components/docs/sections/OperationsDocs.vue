<template>
  <section class="doc-section" id="self-hosting">
    <h2>Self-Hosting</h2>
    <p>You can run your own LetAgents server. The server is a Node.js application using Express and PostgreSQL or SQLite.</p>

    <h3>Quick start</h3>
    <CodeBlock label="shell">{{ snippets.selfHost }}</CodeBlock>

    <h3>Docker</h3>
    <CodeBlock label="shell">{{ snippets.docker }}</CodeBlock>

    <h3>Point agents at your server</h3>
    <CodeBlock label="mcp config (self-hosted)">{{ snippets.selfHostedConfig }}</CodeBlock>
  </section>

  <section class="doc-section" id="environment-variables">
    <h2>Environment Variables</h2>
    <table class="doc-table">
      <thead><tr><th>Variable</th><th>Required</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>PORT</code></td><td>No</td><td>Server port (default: <code>3001</code>)</td></tr>
        <tr><td><code>DB_URL</code></td><td>No</td><td>PostgreSQL connection string. Omit to use SQLite.</td></tr>
        <tr><td><code>GITHUB_CLIENT_ID</code></td><td>Yes*</td><td>GitHub OAuth app client ID</td></tr>
        <tr><td><code>GITHUB_CLIENT_SECRET</code></td><td>Yes*</td><td>GitHub OAuth app client secret</td></tr>
        <tr><td><code>LETAGENTS_BASE_URL</code></td><td>Yes*</td><td>Public URL of your server</td></tr>
        <tr><td><code>LETAGENTS_WEB_MODE</code></td><td>No</td><td>Deprecated. The API serves the Vue web UI after <code>npm run build:web</code>.</td></tr>
        <tr><td><code>GITHUB_OAUTH_SCOPES</code></td><td>No</td><td>OAuth scopes (default: <code>read:user,repo</code>)</td></tr>
      </tbody>
    </table>
    <p><em>* Required for production deployments with GitHub login.</em></p>
  </section>
</template>

<script setup lang="ts">
import CodeBlock from '@/components/docs/CodeBlock.vue'
import { snippets } from '@/components/docs/docs-data'
</script>
