# Prompt Keywords V3

This extension for stable-diffusion-webui (Forge Neo) adds keywords using the extra networks syntax. They let you set generation parameters from inside the prompt, and allow randomization of those parameters when combined with the [Dynamic Prompts](https://github.com/adieyal/sd-dynamic-prompts/tree/main/sd_dynamic_prompts) extension.

## Example

When used with Dynamic Prompts, this prompt will pick a random checkpoint each batch:

```
{<checkpoint:animefull-latest>|<checkpoint:wd15-beta1-fp32>}
```

And you can use random choices inside keywords too:

```
<width:{512|768}>, <height:{512|768}>
```

You can also assemble a wildcard list containing text like sampler names to choose from, and deploy it inside the keywords:

```
<sampler_name:__samplers__>
```

## List of Keywords

The extension adds the following special keywords to be used in prompts:

- `<checkpoint:animefull-latest.ckpt>` - SD Checkpoint
- `<cfg_scale:7>` - CFG Scale
- `<distilled_cfg_scale:2.5>` - Distilled CFG Scale (Flux)
- `<seed:1>` - Seed
- `<subseed:1>` - Subseed
- `<subseed_strength:0.5>` - Subseed Strength
- `<sampler_name:Euler a>` - Sampler Name
- `<scheduler:Automatic>` - Scheduler Name
- `<steps:20>` - Sampling Steps
- `<width:512>` - Width
- `<height:512>` - Height
- `<tiling:true>` - Tiling
- `<restore_faces:true>` - Restore Faces
- `<s_churn:0>` - Sigma Churn
- `<s_tmin:0>` - Sigma Min
- `<s_tmax:0>` - Sigma Max
- `<s_noise:1>` - Sigma Noise
- `<eta:0.5>` - Eta
- `<ddim_discretize:quad>` - DDIM Discretize
- `<denoising_strength:0.7>` - Denoising Strength
- `<hr_scale:2>` - Hires. Fix Upscale By (txt2img)
- `<hr_upscaler:Latent>` - Hires. Fix Upscaler (txt2img)
- `<hr_second_pass_steps:10>` - Hires. Fix Steps (txt2img)
- `<hr_resize_x:1024>` - Hires. Fix Resize Width To (txt2img)
- `<hr_resize_y:1024>` - Hires. Fix Resize Height To (txt2img)
- `<mask_blur:2>` - Mask Blur (img2img)
- `<inpainting_mask_weight:2>` - Inpainting Mask Weight (img2img)

## Behavior

- Keywords are applied *per batch*, not per prompt. Only the first prompt of a batch is evaluated.
- If the same keyword appears several times, only the first one counts.
- `<checkpoint:...>` is loaded first, wherever it sits in the prompt, before LoRAs and all other keywords.
- Boolean keywords (`tiling`, `restore_faces`) accept `1`, `true`, `yes` and `on`. Any other value means off.
- Numeric values are clamped to a minimum: `steps` >= 1, `cfg_scale` >= 1, `width`/`height` >= 64 (rounded down to a multiple of 8), and so on.
- Names of samplers, schedulers, upscalers and checkpoints are case-sensitive.
- All keyword tags are removed from the prompts once they are applied (positive, negative and hires prompts, and the infotext). Other tags, such as LoRA tags, are kept in the infotext.

## Settings

Settings section `PromptKeywords` (key `prompt_keywords`) contains the option `prompt_keywords_debug` ("Print debug messages").

## FORK

I'm not a Python expert but I fixed some issues as best as I could.

1. `width` and `height` keywords are working again.
2. Keywords are updated and applied once per batch. They were applied per batch, but updated per prompt before.
3. Keywords are updated and applied once per `XYZ Plot` despite `Batch Count`. Use `Infinite Generation` instead of setting `Batch Count`, so keywords are updated and applied per generation.
4. Keywords are removed from the prompt once they are applied. They used to stay in the prompt before, distracting you.
