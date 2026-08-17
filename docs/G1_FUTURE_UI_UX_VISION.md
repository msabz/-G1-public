# G1 DirectChat — Future UI/UX Vision

**Status:** Official product goal  
**Companion goals:** `docs/G1_NEXT_PHASE_PRODUCT_GOALS.md`  
**Companion engineering memory:** `docs/G1_NETWORKING_DEVELOPMENT_MEMORY.md`

## Product goal

G1 should ultimately have an interface that feels **extremely modern, distinctive, premium, and almost futuristic**, while remaining immediately understandable and easy to operate.

The goal is **not** visual complexity. The goal is advanced technology presented through radical simplicity.

Target principle:

> **Future-looking outside, simple inside.**

A normal user should be able to open G1 and understand the important actions without learning networking terminology, transport concepts, IP addresses, or complicated navigation.

## Core UX principles

1. **Futuristic without being gimmicky.** Use modern motion, depth, typography, spatial hierarchy, transitions, responsive states, and polished micro-interactions, but avoid visual noise and decorative effects that reduce usability.
2. **Zero networking complexity for normal users.** LAN, Wi-Fi Direct, Bluetooth, discovery, endpoint selection, fallback, promotion, routing, and reconnection should normally remain invisible. The UI should show people/devices and meaningful connection state, not implementation details.
3. **Minimal cognitive load.** Common actions such as chat, call, video call, file sharing, application sharing, accepting a call, and viewing transfer progress should require as few decisions and taps as practical.
4. **Information appears when needed.** Advanced controls and diagnostics belong in Developer/Advanced Mode rather than the primary interface.
5. **Motion communicates state.** Animations should explain connection, discovery, transfer, call, success, failure, and transitions. Animation must never delay an action merely for decoration.
6. **Fast perceived performance.** Immediate touch feedback, optimistic but truthful UI state, skeleton/loading states where necessary, smooth lists, and no unexplained blank screens.
7. **Consistent visual system.** Build reusable design tokens/components for spacing, typography, radii, surfaces, icons, motion, elevation/depth, states, and accessibility rather than styling screens independently.
8. **Accessibility remains mandatory.** Futuristic visuals must retain readable contrast, scalable text, meaningful touch targets, screen-reader semantics, reduced-motion behavior, and clear non-color-only status indicators.
9. **Dark and light environments should both feel intentional.** The visual identity should not be a dark-theme-only effect.
10. **Functionality outranks decoration.** No glass, blur, glow, animation, shader, background effect, or visual treatment should materially harm battery life, responsiveness, readability, accessibility, or transfer/call performance.

## Desired user impression

The intended reaction is not “this interface has many effects.” It should be:

- the app feels unusually advanced;
- everything important is obvious;
- networking seems automatic;
- transitions feel continuous rather than screen-to-screen mechanical;
- calls and transfers feel alive and clearly represented;
- the product has its own visual identity rather than looking like a generic React Native template;
- despite the sophistication, a new user can operate it immediately.

## Key experience targets

### Discovery / Home

Peers should appear naturally as available identities/devices. Discovery should feel continuous and automatic. Avoid exposing raw IP addresses or transport mechanics in the normal interface.

The UI may communicate states such as nearby, available, connecting, connected, reconnecting, transferring, or unavailable using subtle visual state changes rather than technical messages.

### Conversation

Chat should prioritize content. Calling, video, files, images, and application sharing should be easy to reach without turning the conversation screen into a control panel.

### Calls

Incoming and active call UI should feel first-class and native-quality. Answer/reject controls must be immediately recognizable. Connection transitions and quality/status should be communicated without exposing WebRTC/network jargon.

### File transfer

Transfers should visually communicate:

- what is being transferred;
- sender/receiver;
- progress;
- speed when useful;
- remaining state/time when reliable;
- verification/completion;
- failure and retry.

The UI should make G1's high-speed direct-transfer capability feel tangible without cluttering the screen.

### APK/APKS sharing and installation

Application sharing should look like sharing an application, not an anonymous `base.apk` file. Preserve application identity/name/icon where available and clearly communicate preparing, transferring, verifying, permission required, installing, and installed states.

### Background / notifications

Message and call notifications should be visually and behaviorally coherent with the in-app design while respecting Android platform conventions. Incoming calls require clear Answer/Reject actions and appropriate call presentation.

## Design-system direction

Before a large visual rewrite, establish a coherent G1 design system. It should define at minimum:

```text
Typography scale
Spacing scale
Surface hierarchy
Corner/radius language
Icon language
Color/semantic-state tokens
Light/dark behavior
Motion durations and easing
Touch/pressed/focus/disabled states
Connection-state visuals
Transfer-state visuals
Call-state visuals
Accessibility constraints
```

Prefer reusable primitives over one-off screen styling.

## Performance guardrail

The futuristic interface must not compromise the engineering strengths of G1.

UI work must not:

- interfere with TCP signaling or file-transfer loops;
- increase JS bridge traffic during bulk transfer unnecessarily;
- cause dropped call frames/audio;
- hold expensive animations continuously in the background;
- create excessive memory pressure;
- delay native notifications or background service behavior.

Profile UI changes on real mid-range Android devices, not only emulators/high-end phones.

## Architectural guardrail

The visual redesign must preserve the established product networking philosophy:

```text
User sees identity and intent
        ↓
UI / product session
        ↓
Transport orchestrator
   LAN | P2P | Bluetooth
```

The UI must not reintroduce a requirement for users to manually select IPs/interfaces/transports during normal operation. Developer Mode remains the place for low-level controls.

## Suggested implementation sequence

Do not perform an uncontrolled whole-app visual rewrite while networking/background work is still being stabilized.

Recommended sequence:

1. Inventory existing screens, flows, components, and UX inconsistencies.
2. Define G1 visual language and reusable design tokens.
3. Build reusable primitives/components.
4. Redesign the highest-frequency flows first: discovery/home, conversation, incoming call, active call, file transfer.
5. Redesign APK/APKS sharing/install flow.
6. Apply coherent motion/micro-interactions.
7. Complete light/dark/accessibility behavior.
8. Run performance and regression testing on real devices.
9. Only then remove obsolete legacy UI components/styles.

## Definition of success

The UI/UX milestone is successful when:

- a first-time user can discover/connect/chat/call/share without explanation;
- normal users never need to understand an IP address or transport;
- core actions are obvious and require minimal interaction;
- the visual identity is recognizably G1 rather than generic Android/React Native styling;
- the interface looks substantially more advanced than the current baseline without becoming confusing;
- animations and effects remain smooth on target devices;
- accessibility remains functional;
- networking, calls, background availability, and transfer throughput show no regression caused by UI work.

## Non-goal

“Futuristic” does **not** mean maximizing effects, controls, panels, gradients, glass, glow, or animation. Any visual element that makes the product harder to understand is contrary to this goal.

The desired endpoint is a product that feels technologically ahead precisely because the underlying complexity has been hidden and the interaction model is simple.
