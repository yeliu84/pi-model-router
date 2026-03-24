# Image Support Auto-Upgrade Plan

## Objective

Automatically upgrade the routing tier if a user attaches an image, but the initially selected tier (e.g., `low`) does not have a model that supports image inputs.

## Background & Motivation

Currently, if the router decides a task is simple and assigns it to the `low` tier, but the user has attached an image, the request may fail if the `low` tier model is text-only. The router should be smart enough to recognize image attachments and guarantee that a vision-capable model is selected.

## Scope & Impact

- Adds context inspection to detect image attachments.
- Hooks into the routing decision flow to evaluate the capabilities of the models configured for the current profile.
- Restricts the search to higher tiers (Strict Upgrade) so we don't accidentally downgrade reasoning just to satisfy the image requirement.

## Proposed Solution

1. **Context Inspection (`extensions/routing.ts`)**
   Add a utility function `hasImageAttachment(context: Context): boolean` that iterates through the message history to check if any message content part has `type === 'image'`.

2. **Capability Checking (`extensions/provider.ts`)**
   In the `streamSimple` method, after the initial `decision` is finalized (and after Classifier/Context triggers):
   - Check if an image is attached.
   - If so, look up the selected tier's model(s) in the model registry.
   - Verify if their `.input` array includes `'image'`.

3. **Tier Upgrade Strategy (`extensions/provider.ts`)**
   - If the current tier does not support images, iterate through strictly higher tiers:
     - If current is `low`: check `medium`, then `high`.
     - If current is `medium`: check `high`.
   - The first higher tier found that supports images will be assigned as the new decision, with reasoning updated (e.g., `"Forced medium tier because the originally routed low tier does not support image attachments."`).

4. **Intra-Tier Filtering (`extensions/provider.ts`)**
   - When building the `modelsToTry` array (which includes the primary model and its fallbacks), filter out any models that lack image support if an image is attached. This ensures that if a primary model lacks vision but a fallback in the same tier has it, the fallback is directly used without unnecessary API failures.

## Verification & Testing

- Use a configuration where `low` is a text-only model (e.g., `gpt-3.5-turbo`) and `medium` is a vision model (e.g., `gpt-4o`).
- Submit a simple prompt ("What is this?") with an image.
- Verify via `/router debug show` or the UI widget that the decision correctly notes the image support override and upgrades the tier.
