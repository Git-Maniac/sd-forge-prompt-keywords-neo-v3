# ---------------------------------------------------------------------------
# Prompt Keywords Forge-NEO v3
# ---------------------------------------------------------------------------
#
# Based on the script RandomizerKeywords with 2 commits for 'scheduler' and 'distilled cfg scale'from:
# https://github.com/InfluxOW/a1111-stable-diffusion-webui-randomizer-keywords/pull/1/files#diff-81cfdc065b5f0f3c89277b2269e1606386d2d07fed2ba5027a4dbe46d1ffd424
# 
# Lets you write settings into the prompt, for example:
#     a cat, <steps:30> <cfg_scale:7> <checkpoint:myModel>
# The tags are read, applied to the generation and removed from the prompt again.
#
# How it works: every keyword is registered as an "extra network" (the same
# mechanism as <lora:...>). The WebUI finds the tags in the prompt and calls
# activate() of the matching keyword before each batch.
#
# Rules:
# - Keywords are applied once per batch, using only the first prompt of the batch.
# - If a keyword appears several times, only the first one counts.

import os
import re

from modules import (
    processing,
    rng,
    script_callbacks,
    scripts,
    sd_models,
    sd_samplers,
    sd_schedulers,
    shared,
    extra_networks,
)

Txt2Img = processing.StableDiffusionProcessingTxt2Img
Img2Img = processing.StableDiffusionProcessingImg2Img

# Set to True when a keyword changed something that needs the random noise (RNG)
# to be rebuilt (size, seed, hires settings or a new checkpoint)
needs_rebuild = False

# Values already read in the current batch (keyword name -> value)
read_values = {}

# Counts finished batches while an XYZ plot runs (the plot calls the WebUI once per cell)
xyz_batches_done = 0

# The XYZ plot stores its three axes in these attributes of shared.state
XYZ_AXES = ("xyz_plot_x", "xyz_plot_y", "xyz_plot_z")


def debug(message):
    # Only prints if the option "Print debug messages" is enabled in the settings
    if shared.opts.data.get("prompt_keywords_debug", False):
        print(f"[Prompt Keywords] {message}")


# ---------------------------------------------------------------------------
# XYZ plot helpers
# ---------------------------------------------------------------------------


def is_xyz_plot():
    # True if an XYZ plot is running (at least one axis has values)
    for name in XYZ_AXES:
        axis = getattr(shared.state, name, None)
        if axis is not None and len(axis.values) > 0:
            return True
    return False


def xyz_plot_size():
    # Number of cells in the XYZ plot (x * y * z)
    size = 1
    for name in XYZ_AXES:
        axis = getattr(shared.state, name, None)
        if axis is not None:
            size *= max(1, len(axis.values))
    return size


def clear_xyz_plot_state():
    for name in XYZ_AXES:
        if hasattr(shared.state, name):
            delattr(shared.state, name)


# ---------------------------------------------------------------------------
# Helpers for values
# ---------------------------------------------------------------------------


def to_bool(value):
    # "1", "true", "yes" and "on" mean True, everything else means False
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def round_down_to_8(value, p):
    # Image sizes must be a multiple of 8
    return value - (value % 8)


def batch_part(p, items):
    # The part of a list that belongs to the current batch
    start = p.iteration * p.batch_size
    return items[start : start + p.batch_size]


def check_sampler_name(value, p):
    # Returns an error text, or None if the value is fine
    if isinstance(p, Img2Img):
        samplers = sd_samplers.samplers_for_img2img
    else:
        samplers = sd_samplers.samplers

    if value not in [sampler.name for sampler in samplers]:
        return f"Invalid sampler '{value}'"
    return None


def check_scheduler_name(value, p):
    # Returns an error text, or None if the value is fine
    names = []
    for scheduler in sd_schedulers.schedulers:
        names.append(scheduler.name)
        names.append(scheduler.label)

    if value not in names:
        return f"Invalid scheduler '{value}'"
    return None


# ---------------------------------------------------------------------------
# Rebuild after changes
# ---------------------------------------------------------------------------


def rebuild(p):
    # Called once per batch if a keyword changed size, seed, hires settings or checkpoint.
    # The WebUI already prepared these things before the keywords were applied,
    # so they have to be prepared again.

    # Hires. fix (txt2img only): let the WebUI recalculate its sizes
    if isinstance(p, Txt2Img):
        for name in ["Hires upscale", "Hires resize", "Hires steps", "Hires upscaler"]:
            p.extra_generation_params.pop(name, None)
        p.init(p.all_prompts, p.all_seeds, p.all_subseeds)
        debug(f"Recalculated Hires. fix (width={p.width}, height={p.height})")

    # Random noise generator: depends on size, seeds and the model's latent channels
    p.rng = rng.ImageRNG(
        (
            shared.sd_model.forge_objects.vae.latent_channels,
            p.height // processing.opt_f,
            p.width // processing.opt_f,
        ),
        p.seeds,
        subseeds=p.subseeds,
        subseed_strength=p.subseed_strength,
        seed_resize_from_h=p.seed_resize_from_h,
        seed_resize_from_w=p.seed_resize_from_w,
    )


def remove_keyword_tags(prompt):
    # Removes all tags of this script, e.g. "<steps:30>". Other tags (LoRA...) stay.
    for keyword in all_keywords:
        prompt = re.sub(rf"<{keyword.name}:[^>]*>", "", prompt)
    return re.sub(r"\n+", "\n", prompt).strip()


# ---------------------------------------------------------------------------
# Keywords
# ---------------------------------------------------------------------------


class SettingKeyword(extra_networks.ExtraNetwork):
    # A keyword that sets one attribute of the generation, e.g. <steps:30> sets p.steps
    #
    # name:      keyword name, also the attribute name on p
    # value_type: function that converts the text into a value (int, float, str, to_bool)
    # minimum:   smallest allowed value (smaller values are raised to it)
    # adjust:    optional function (value, p) -> new value
    # check:     optional function (value, p) -> error text or None
    # only_for:  optional class, the keyword is ignored for other generation types
    def __init__(self, name, value_type, minimum=None, adjust=None, check=None, only_for=None):
        super().__init__(name)
        self.value_type = value_type
        self.minimum = minimum
        self.adjust = adjust
        self.check = check
        self.only_for = only_for

    def activate(self, p, params_list):
        global needs_rebuild

        # Called for every keyword before every batch. Empty list = tag not in prompt.
        if not params_list:
            return
        if self.only_for and not isinstance(p, self.only_for):
            return

        # Only the first tag counts. The value is read once and then reused
        # (XYZ plot: the same value for the whole plot).
        if self.name not in read_values:
            read_values[self.name] = self.value_type(params_list[0].items[0])
        value = read_values[self.name]

        if self.adjust:
            value = self.adjust(value, p)

        if self.minimum is not None:
            value = max(value, self.minimum)

        if self.check:
            error = self.check(value, p)
            if error:
                raise RuntimeError(f"Keyword '{self.name}' failed: {error}")

        # The WebUI already created the seeds before the keywords were applied,
        # so the seed lists have to be replaced as well. -1 means random.
        if self.name == "seed":
            value = processing.get_fixed_seed(value)
            p.all_seeds = [
                value + (i if p.subseed_strength == 0 else 0)
                for i in range(len(p.all_prompts))
            ]
            p.seeds = batch_part(p, p.all_seeds)
        elif self.name == "subseed":
            value = processing.get_fixed_seed(value)
            p.all_subseeds = [value + i for i in range(len(p.all_prompts))]
            p.subseeds = batch_part(p, p.all_subseeds)

        debug(f"Set {self.name} -> {value}")
        setattr(p, self.name, value)

        if self.name in ("width", "height", "seed", "subseed") or self.name.startswith("hr_"):
            needs_rebuild = True

    def deactivate(self, p):
        # Required by the WebUI (the base class raises NotImplementedError). Nothing to do.
        pass


def load_checkpoint(p, name):
    # Loads the checkpoint (does nothing if it is already loaded)
    global needs_rebuild

    info = sd_models.get_closet_checkpoint_match(name)
    if info is None:
        raise RuntimeError(f"Unknown checkpoint: {name}")

    # During an XYZ plot the checkpoint is only loaded at the very start
    if xyz_batches_done == 0:
        data = sd_models.model_data
        if data.forge_loading_parameters.get("checkpoint_info") is not info:
            # Forge loads models from these parameters: change them, then reload
            data.forge_loading_parameters = {
                **data.forge_loading_parameters,
                "checkpoint_info": info,
            }
            sd_models.forge_model_reload()
            needs_rebuild = True  # the new model may use other latent channels
            debug(f"Loaded checkpoint {info.name}")

    # Shown in the image info
    p.sd_model_name = info.name_for_extra
    p.sd_model_hash = shared.sd_model.sd_model_hash


class CheckpointKeyword(extra_networks.ExtraNetwork):
    # <checkpoint:name> switches the model.
    # It is normally loaded earlier by Script.before_process_batch (before the LoRAs).
    def __init__(self):
        super().__init__("checkpoint")

    def activate(self, p, params_list):
        if params_list:
            load_checkpoint(p, params_list[0].items[0])

    def deactivate(self, p):
        # Required by the WebUI (the base class raises NotImplementedError). Nothing to do.
        pass


# All keywords. Parameters are attributes of the Processing class (p).
all_keywords = [
    SettingKeyword("cfg_scale", float, minimum=1),
    SettingKeyword("distilled_cfg_scale", float, minimum=0),
    SettingKeyword("seed", int, minimum=-1),
    SettingKeyword("subseed", int, minimum=-1),
    SettingKeyword("subseed_strength", float, minimum=0),
    SettingKeyword("sampler_name", str, check=check_sampler_name),
    SettingKeyword("scheduler", str, check=check_scheduler_name),
    SettingKeyword("steps", int, minimum=1),
    SettingKeyword("width", int, minimum=64, adjust=round_down_to_8),
    SettingKeyword("height", int, minimum=64, adjust=round_down_to_8),
    SettingKeyword("tiling", to_bool),
    SettingKeyword("restore_faces", to_bool),
    SettingKeyword("s_churn", float),
    SettingKeyword("s_tmin", float),
    SettingKeyword("s_tmax", float),
    SettingKeyword("s_noise", float),
    SettingKeyword("s_min_uncond", float),
    SettingKeyword("eta", float, minimum=0),
    SettingKeyword("ddim_discretize", str),
    SettingKeyword("denoising_strength", float),
    # txt2img only
    SettingKeyword("hr_scale", float, minimum=1, only_for=Txt2Img),
    SettingKeyword("hr_upscaler", str, only_for=Txt2Img),
    SettingKeyword("hr_second_pass_steps", int, minimum=1, only_for=Txt2Img),
    SettingKeyword("hr_cfg", float, minimum=1, only_for=Txt2Img),
    SettingKeyword("hr_distilled_cfg", float, minimum=0, only_for=Txt2Img),
    SettingKeyword("hr_sampler_name", str, check=check_sampler_name, only_for=Txt2Img),
    SettingKeyword("hr_scheduler", str, check=check_scheduler_name, only_for=Txt2Img),
    SettingKeyword("hr_resize_x", int, minimum=64, adjust=round_down_to_8, only_for=Txt2Img),
    SettingKeyword("hr_resize_y", int, minimum=64, adjust=round_down_to_8, only_for=Txt2Img),
    # img2img only
    SettingKeyword("mask_blur", float, only_for=Img2Img),
    SettingKeyword("inpainting_mask_weight", float, only_for=Img2Img),
    # model
    CheckpointKeyword(),
]


# ---------------------------------------------------------------------------
# The script itself (the WebUI calls these methods during generation)
# ---------------------------------------------------------------------------


class Script(scripts.Script):
    def title(self):
        return "Prompt Keywords"

    def show(self, is_img2img):
        # No own UI, always active
        return scripts.AlwaysVisible

    def setup(self, p, *args, **kwargs):
        # Start of a generation: forget old values.
        # The XYZ plot state is not cleared here, because the plot calls this
        # once per cell. It is cleared in postprocess_batch when the plot is done.
        read_values.clear()

    def before_process_batch(self, p, *args, **kwargs):
        # Runs before the WebUI reads the tags and activates LoRAs.
        # Load the checkpoint now, wherever its tag is in the prompt,
        # so that LoRAs are applied to the new model.
        match = re.search(r"<checkpoint:([^>:]*)", p.prompts[0])
        if match:
            load_checkpoint(p, match.group(1).strip())

    def process_batch(self, p, *args, **kwargs):
        # Runs after all keywords were applied
        global needs_rebuild
        if needs_rebuild:
            rebuild(p)
            needs_rebuild = False

        # Remove our tags from all prompts. The WebUI already removed them from
        # p.prompts, but not from the negative/hires prompts and the "all_*" lists
        # (used for the image info).
        for name in ("prompts", "negative_prompts", "hr_prompts", "hr_negative_prompts"):
            prompts = getattr(p, name, None)
            if isinstance(prompts, list):
                setattr(p, name, [remove_keyword_tags(x) for x in prompts])

        # "all_*" lists contain the prompts of ALL batches. Only clean the current
        # batch: the later batches still need their tags.
        start = p.iteration * p.batch_size
        end = start + p.batch_size
        for name in ("all_prompts", "all_negative_prompts", "all_hr_prompts", "all_hr_negative_prompts"):
            prompts = getattr(p, name, None)
            if isinstance(prompts, list):
                setattr(p, name, [
                    remove_keyword_tags(x) if start <= i < end else x
                    for i, x in enumerate(prompts)
                ])

    def postprocess_batch(self, p, *args, **kwargs):
        # Runs after every batch
        global xyz_batches_done

        xyz = is_xyz_plot()
        if xyz:
            xyz_batches_done += 1

        plot_finished = xyz_batches_done >= xyz_plot_size() * p.n_iter
        aborted = shared.state.interrupted or shared.state.stopping_generation

        # Normal generation: values are read again for the next batch.
        # XYZ plot: values are kept until the whole plot is finished or aborted.
        if not xyz or plot_finished or aborted:
            xyz_batches_done = 0
            read_values.clear()
            if xyz:
                clear_xyz_plot_state()


# ---------------------------------------------------------------------------
# Data for the autocomplete list (javascript/prompt_keywords_autocomplete.js)
# ---------------------------------------------------------------------------


def value_choices(name):
    # Possible values of a keyword, shown in the autocomplete list after "<name:". Empty list = free input.
    if name == "checkpoint":
        return sorted(info.name_for_extra for info in sd_models.checkpoints_list.values())
    if name in ("sampler_name", "hr_sampler_name"):
        return [sampler.name for sampler in sd_samplers.samplers]
    if name in ("scheduler", "hr_scheduler"):
        return [scheduler.label for scheduler in sd_schedulers.schedulers]
    if name == "hr_upscaler":
        return [upscaler.name for upscaler in shared.sd_upscalers]
    if name == "ddim_discretize":
        return ["uniform", "quad"]
    return []


def value_previews(name):
    # Preview images for the values of a keyword: {value: image url}. Only checkpoints have them.
    # They are the same images the "Checkpoints" tab shows (name.png or name.preview.png).
    if name != "checkpoint":
        return {}

    # Imported here because the extra networks page may not exist yet when the script loads
    from modules import ui_extra_networks

    page = None
    for candidate in ui_extra_networks.extra_pages:
        if candidate.name == "checkpoints":
            page = candidate
    if page is None:
        return {}

    previews = {}
    for info in sd_models.checkpoints_list.values():
        path = os.path.splitext(info.filename)[0]
        url = page.find_preview(path)
        if url:
            # "./sd_extra_networks/..." -> "/sd_extra_networks/..."
            previews[info.name_for_extra] = url.lstrip(".")
    return previews


def keyword_info(keyword):
    # Describes one keyword for the autocomplete list: its name, a short type text and where it works
    if isinstance(keyword, SettingKeyword):
        type_text = TYPE_TEXTS.get(keyword.value_type, "text")
        if keyword.only_for is Txt2Img:
            where = "txt2img"
        elif keyword.only_for is Img2Img:
            where = "img2img"
        else:
            where = ""
    else:
        type_text = "text"
        where = ""

    values = value_choices(keyword.name)
    if type_text == "true/false":
        values = ["true", "false"]

    return {
        "name": keyword.name,
        "type": type_text,
        "where": where,
        "values": values,
        "previews": value_previews(keyword.name),
    }


# Short type names for the autocomplete list (value_type function -> text)
TYPE_TEXTS = {int: "int", float: "float", str: "text", to_bool: "true/false"}


def add_api(app):
    # The autocomplete script loads its keyword list from here, so the list only exists once (all_keywords)
    @app.get("/prompt_keywords/keywords")
    def get_keywords():
        # Sorted alphabetically for the autocomplete list (all_keywords itself keeps its order)
        return [keyword_info(keyword) for keyword in sorted(all_keywords, key=lambda k: k.name)]


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


def on_app_started(demo, app):
    print(f"[Prompt Keywords] Supported keywords: {', '.join(k.name for k in all_keywords)}")
    for keyword in all_keywords:
        extra_networks.register_extra_network(keyword)
    add_api(app)


def on_ui_settings():
    shared.opts.add_option(
        "prompt_keywords_debug",
        shared.OptionInfo(
            False,
            "Print debug messages",
            section=("prompt_keywords", "Prompt Keywords"),
        ),
    )
    shared.opts.add_option(
        "prompt_keywords_autocomplete",
        shared.OptionInfo(
            True,
            "Show keyword suggestions when typing '<' in the prompt (reload the page after changing)",
            section=("prompt_keywords", "Prompt Keywords"),
        ),
    )


script_callbacks.on_app_started(on_app_started)
script_callbacks.on_ui_settings(on_ui_settings)
