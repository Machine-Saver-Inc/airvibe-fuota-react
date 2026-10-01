# AirVibe FUOTA React

<!-- machine-saver-scope:start -->
## Scope

Existing React/Vite AirVibe packet and waveform visualization application; verify implemented behavior before assigning additional firmware-update responsibilities.

**Owner:** Machine-Saver-Inc. **Development area:** Applications and documentation.

## Ownership boundaries

The repository name alone does not establish a complete FUOTA service. Device-side update/recovery and shared transfer semantics belong with their respective owners.

## Development tracking

Track work in this repository's issues and pull requests. Cross-repository work is coordinated through the [Machine Saver development Projects](https://github.com/orgs/Machine-Saver-Inc/projects).

Follow this repository's contribution instructions and preserve links to related product issues. Scope describes responsibility; release and deployment readiness require the repository's own evidence.
<!-- machine-saver-scope:end -->

This project hosts a standalone React + Vite UI for visualising AirVibe waveform download packets.

## Getting started

```bash
npm install
npm run dev
```

Visit the local URL printed in the terminal to load the app.

To create a production bundle:

```bash
npm run build
```
