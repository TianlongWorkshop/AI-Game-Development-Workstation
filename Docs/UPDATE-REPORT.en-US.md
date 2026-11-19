# AI Game Workstation Update Report (English)

Scope: public source preview `2.0.0-preview.6`; the current clean installer is still `2.0.0-preview.5` and should be rebuilt after the source version is stabilized.

Date: 2026-11-19

## 1. What this update addresses

The AI Game Workstation is not a collection of chat windows. It places real game-development inputs, professional tools, AI suggestions, human approval, and verified outputs on one traceable path.

This public update includes:

- original source code, the Blender bridge, the Unreal Engine bridge, and bilingual documentation;
- separate 3D, animation, art/materials, and Unreal Engine workspaces;
- canvas inputs for images, video, models, notes, and reference collections;
- source, version, media time range, purpose labels, and human corrections;
- scope, diff, and approval before AI execution;
- stage logs, checkpoints, undo-oriented state, and output receipts;
- local Blender bridging and Unreal Engine connection, structural checks, and compile-log interfaces;
- public design, tests, acceptance records, and honest capability boundaries.

## 2. Technology used

### Desktop and business layer

- Electron Windows desktop runtime;
- JavaScript/CommonJS business modules;
- HTML/CSS/JavaScript workspace UI;
- local files, project folders, and JSON state;
- Node.js test runner;
- Windows file selection, process launch, and path validation.

### AI and model routing

The source provides local-first planning and a model capability registry. It can select an adapter based on a task and records model-call budgets and history.

DeepSeek integration code is present. Cloud calls show scope and an estimated cost ceiling. The current version does not claim that every common game-development model is already connected or production-validated.

### Blender bridge

The Blender bridge uses a local service and a Blender Python extension for controlled scene, object, material, viewport, and GLB/GLTF/FBX operations. The final edit remains in Blender. The workstation does not silently upload a Blender project to a remote service.

### Unreal Engine 5 bridge

The UE bridge is under `plugins/unreal/AIGWBridge/`. It provides project/editor connection, version hints, blueprint structure and text checks, and compile-log interfaces. Full blueprint graph editing, arbitrary node generation, and binaries for every UE version remain future work.

### Assets and media

The workstation handles images, video, GLB/GLTF/FBX/OBJ/Blend models, Markdown/text/code notes, project references, reference collections, canvas wires, video frames, time ranges, and human annotations.

A reference is not a destructive copy: source, version, and hash are retained, and deleting a canvas node does not delete the original asset.

## 3. Recommended workflow

1. Start the workstation and create or open a project.
2. Import your own images, video, models, and notes.
3. Enter the relevant workspace: 3D, animation, art/materials, or Unreal Engine.
4. Drag assets onto the canvas, assign purposes, and build reference collections.
5. Select the real data that AI may use and review its scope and diff.
6. Edit the prompt, parameters, or connections, then approve the task.
7. Follow stage logs, checkpoints, and output branches.
8. Read the result back in Blender or Unreal Engine.
9. Save the output receipt, validation result, and version information.

## 4. Design principles

### Human-led, AI-assisted

The user chooses real data, models, approvals, and final outputs. AI must not silently overwrite a project.

### Separate workspaces

3D, animation, art/materials, and Unreal Engine each have their own canvas and professional view. Shared capabilities connect through explicit inputs and outputs rather than mixing every node type together.

### Local first

Projects, assets, bridges, and acceptance checks run locally whenever possible. Network access is reserved for user-selected models, updates, or authorization, not a hidden execution channel.

### Verifiable delivery

A capability is not proven by the presence of a button. It needs real files, logs, hashes, professional-tool readback, or a user-reviewable diff.

## 5. Technical metrics and acceptance evidence

Current records contain:

- 65 automated tests discovered, 64 passed;
- 1 Windows symlink test blocked before its assertion because this environment lacks symlink creation permission;
- packaging tests passed, including delivered-source boundaries;
- Blender 4.4.1 validation;
- 38 meshes, 5,286 vertices, and 4,104 triangles in the validated mesh set;
- a real crate workflow round trip with Blend, GLB, preview, validation, and task receipt;
- canvas acceptance for images, video, models, references, wires, time ranges, human corrections, and blueprint text checks.

These are acceptance records, not guarantees for every model, computer, or Blender/UE version.

## 6. Comparison with the local UeToolkit sample

The comparison below is based on static inspection of the local `UeToolkit` 3.5.0 sample (the type of product referred to as “Unreal Toolbox”). It does not replace verification of its remote service, pricing, or terms.

| Area | AI Game Workstation | UeToolkit sample |
| --- | --- | --- |
| Core position | Human-led AI game-production workstation | UE asset management, import, and plugin tool |
| Workflow | Real inputs → canvas → AI suggestion → approval → professional tool → validation | Asset scan, thumbnails, import, plugin installation, project management |
| AI role | Planning, model routing, reference collections, scope, and diff | Local files confirm licensing and asset tooling; equivalent AI workflow cannot be proven from the package alone |
| Blender | Local bridge and production workspace | Primarily local asset tooling in the inspected package; bridge scope needs separate validation |
| UE compatibility | Public AIGW Bridge and project connection interfaces | Nine UE plugin builds from 5.0.3 to 5.8.2; more mature versioned plugin packaging |
| Asset packages | Source, hash, version, and workspace references | Broad zip/7z/rar extraction, password credentials, thumbnails, and import transactions |
| Approval and traceability | Scope, diff, task logs, checkpoints, and receipts | Stronger emphasis on asset and plugin transactions |
| Open-source scope | Original source, bridges, and design docs are public | The local package is primarily a packaged PyQt/Python client; server code is not included |
| Commercial model | Public source is not tied to a paid service | The sample contains trial, monthly, permanent licensing, and remote verification code |

## 7. Our main advantages

### 1. Built for making, not only managing

The UeToolkit sample is stronger in asset search, import, thumbnails, and UE plugin installation. Our focus is to connect creative input, AI suggestions, human approval, and final production.

### 2. Approval is part of the product structure

AI tasks expose input scope, output branches, and differences. The user can reject execution or continue editing in Blender or UE.

### 3. Traceable source and versions

Images, video, models, and notes retain source, hash, version, and purpose. Recognition results do not silently replace human corrections.

### 4. Blender and UE in one production chain

The workstation is not only an UE asset catalog. It joins Blender modeling, animation, materials, and UE project checks in one local workflow.

### 5. Open and reviewable

Original source, bridges, tests, and design records are available for global developers to inspect, modify, and reproduce. Installers and third-party dependencies remain separately documented.

### 6. Honest boundaries

The docs explicitly state that full blueprint graph editing, automatic skinning, complete PBR generation, and arbitrary text-to-3D are unfinished. That makes collaboration more reliable than marketing an unfinished placeholder as a finished tool.

## 8. Where the UeToolkit sample is stronger

We should state this clearly:

- more complete versioned UE Launcher plugin binaries and build identifiers;
- mature plugin installation, backup, hash verification, and rollback;
- broader archive, thumbnail, asset-library, and import transaction coverage;
- productized trial, monthly, permanent licensing, offline grace, and update services.

We should not claim that the workstation already replaces it completely. A more accurate position is: the workstation owns creative orchestration and AI assistance, while asset management and UE plugin productization should continue to learn from mature tools.

## 9. Current limits and next update

### Current limits

- The installer is still `preview.5` while the public source is `preview.6`; the versions must be rebuilt and aligned.
- A signed installer and a clean-machine end-to-end acceptance pass are still pending.
- Multi-version UE binary plugin installation is not yet as mature as the inspected UeToolkit sample.
- Full material nodes, blueprint graph editing, automatic skinning, and motion-capture retargeting remain in development.
- There is no large-library scan, concurrency, or GPU benchmark yet.
- The public source excludes user projects, caches, keys, generated assets, and commercial third-party assets.

### Next steps

1. Rebuild an installer matching the source version.
2. Add version manifests, hashes, and automated install acceptance for Blender and UE bridges.
3. Improve thumbnails, tags, duplicate detection, and project-level indexing.
4. Add art/material nodes for color, normal, roughness, metallic, AO, displacement, specular, emission, masks, and subsurface scattering.
5. Expand UE blueprint reading, connection checks, locating, compiling, and log readback.
6. Publish repeatable performance reports on clean machines and large asset libraries.

## 10. Release model

The source repository contains source, bridges, design, tests, technical metrics, and bilingual documentation.

GitHub Release assets contain the installer, SHA-256 checksums, changelog, and installation instructions.

The repository does not contain personal projects, user media, caches, credentials, test output folders, commercial assets, or machine-specific paths.
