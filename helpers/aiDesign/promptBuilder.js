const MAX_PROMPT_LENGTH = 32000;

const DEFAULT_DESIGN_INSTRUCTIONS = `
Create a polished, professional graphic design.

DESIGN REQUIREMENTS:
- Make the composition visually balanced and well organized.
- Establish a clear visual hierarchy.
- Use readable typography with appropriate font sizes.
- Maintain good contrast between text and background.
- Use spacing and alignment consistently.
- Make the design visually appealing and suitable for its intended audience.
- Avoid unnecessary decorative elements and visual clutter.
- Do not add unrelated text, fake logos, or watermarks.

TEXT ACCURACY:
- Preserve all user-provided text exactly.
- Do not invent prices, discounts, dates, contact details, or promotional claims.
- Make important promotional information easy to notice.

OUTPUT:
- Generate one complete, finished graphic.
- Do not generate a mockup of the design displayed on a wall, phone, or billboard.
- The output should be the actual flat graphic, ready for use.
`;

/**
 * Validate an optional text field.
 */
const normalizeText = (value, fieldName, maxLength = 2000) => {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: "" };
  }

  if (typeof value !== "string") {
    return {
      ok: false,
      error: `DESIGN_${fieldName.toUpperCase()}_INVALID`,
    };
  }

  const normalized = value.trim();

  if (normalized.length > maxLength) {
    return {
      ok: false,
      error: `DESIGN_${fieldName.toUpperCase()}_TOO_LONG`,
    };
  }

  return { ok: true, value: normalized };
};

/**
 * Build a complete image-generation prompt.
 *
 * This function creates text instructions only.
 * Uploaded images are passed separately to the image API.
 */
const buildDesignPrompt = ({
  prompt,
  designType = "promotional graphic",
  platform = "",
  dimensions = "",
  style = "",
  targetAudience = "",
  brandName = "",
  requiredText = [],
  additionalInstructions = "",
  referenceImagesCount = 0,
  assetsCount = 0,
  socialReferences = [],
} = {}) => {
  const fields = {
    prompt: normalizeText(prompt, "prompt", MAX_PROMPT_LENGTH),
    designType: normalizeText(designType, "design_type"),
    platform: normalizeText(platform, "platform"),
    dimensions: normalizeText(dimensions, "dimensions"),
    style: normalizeText(style, "style"),
    targetAudience: normalizeText(targetAudience, "target_audience"),
    brandName: normalizeText(brandName, "brand_name"),
    additionalInstructions: normalizeText(
      additionalInstructions,
      "additional_instructions",
      4000,
    ),
  };

  const invalidField = Object.values(fields).find((field) => !field.ok);

  if (invalidField) {
    return invalidField;
  }

  if (!fields.prompt.value) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_PROMPT_REQUIRED",
    };
  }

  if (
    !Array.isArray(requiredText) ||
    requiredText.length > 30 ||
    !requiredText.every(
      (item) =>
        typeof item === "string" &&
        item.trim().length > 0 &&
        item.length <= 500,
    )
  ) {
    return {
      ok: false,
      error: "DESIGN_REQUIRED_TEXT_INVALID",
    };
  }

  if (
    !Number.isInteger(referenceImagesCount) ||
    referenceImagesCount < 0 ||
    !Number.isInteger(assetsCount) ||
    assetsCount < 0 ||
    referenceImagesCount + assetsCount > 8
  ) {
    return {
      ok: false,
      error: "DESIGN_IMAGE_COUNT_INVALID",
    };
  }

  if (!Array.isArray(socialReferences)) {
    return {
      ok: false,
      error: "DESIGN_SOCIAL_REFERENCES_INVALID",
    };
  }

  const sections = [
    "YOUR ROLE:\nYou are a professional graphic designer.",
    `DESIGN REQUEST:\n${fields.prompt.value}`,
    `DESIGN TYPE:\n${fields.designType.value || "Promotional graphic"}`,
  ];

  if (fields.platform.value) {
    sections.push(`INTENDED PLATFORM:\n${fields.platform.value}`);
  }

  if (fields.dimensions.value) {
    sections.push(`DESIGN DIMENSIONS:\n${fields.dimensions.value}`);
  }

  if (fields.style.value) {
    sections.push(`VISUAL STYLE:\n${fields.style.value}`);
  }

  if (fields.targetAudience.value) {
    sections.push(`TARGET AUDIENCE:\n${fields.targetAudience.value}`);
  }

  if (fields.brandName.value) {
    sections.push(`BRAND NAME:\n${fields.brandName.value}`);
  }

  if (requiredText.length > 0) {
    sections.push(
      `EXACT TEXT TO INCLUDE:\n${requiredText
        .map((item) => `- ${item.trim()}`)
        .join("\n")}`,
    );
  }

  if (referenceImagesCount > 0) {
    sections.push(`
REFERENCE IMAGES:
There are ${referenceImagesCount} reference image(s).
Use them to understand the requested visual direction,
layout, composition, and style.

Use them as inspiration rather than copying unrelated
branding, text, or content from them.
`);
  }

  if (assetsCount > 0) {
    sections.push(`
ACTUAL IMAGE ASSETS:
There are ${assetsCount} uploaded asset(s).
Treat these as content intended for the final design.
Preserve recognizable product details and logos.
Do not replace them with invented alternatives.
`);
  }

  if (fields.additionalInstructions.value) {
    sections.push(
      `ADDITIONAL INSTRUCTIONS:\n${fields.additionalInstructions.value}`,
    );
  }

  sections.push(DEFAULT_DESIGN_INSTRUCTIONS);

  const finalPrompt = sections.join("\n\n").trim();

  if (finalPrompt.length > MAX_PROMPT_LENGTH) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_PROMPT_TOO_LONG",
    };
  }

  return {
    ok: true,
    prompt: finalPrompt,

    // Keep these as metadata for the future controller.
    metadata: {
      designType: fields.designType.value || "promotional graphic",
      platform: fields.platform.value || null,
      dimensions: fields.dimensions.value || null,
      style: fields.style.value || null,
      targetAudience: fields.targetAudience.value || null,
      brandName: fields.brandName.value || null,
      referenceImagesCount,
      assetsCount,
      socialReferences,
    },
  };
};

module.exports = {
  buildDesignPrompt,
};
