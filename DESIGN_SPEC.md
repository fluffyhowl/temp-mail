# Critical Project Safety Rules

This project already has working frontend and backend.

UI work must not break existing functionality.

Protected areas:
- Backend logic
- API routes
- Database code
- Authentication
- Environment files
- package.json
- lock files
- Email generation logic
- Captcha logic
- Copy and refresh behavior
- Existing API calls

Allowed changes:
- Landing page layout
- CSS/Tailwind classes
- Visual spacing
- Typography
- Colors
- Borders
- Buttons
- Responsive layout
- Decorative illustration only if it does not affect logic

# Design Spec - Temp Mail Landing Page

## Goal
Create a dark, clean, minimal temporary email landing page matching the provided reference image.

## Visual Style
- Dark background, not pure black.
- Main background: #242424 or close.
- Card/input background: slightly lighter dark gray.
- Primary accent: bright blue similar to #3EA2FF.
- Text: white / near-white.
- Secondary text: muted gray.
- No gradients unless explicitly requested.
- No glassmorphism.
- No excessive animation.
- No neon effect.
- No random decorative UI outside the reference.

## Layout - Desktop
- Full landing section.
- Left side:
  - Logo text: "Temp-mail"
  - Top navigation: Home, About us, privacy, Terms
  - Hero title: "Free Temporary Email."
  - Short paragraph below.
  - Feature row: Valid for 1 hour, Free, Secure
  - Email generator card below.
- Right side:
  - Large illustration area with mailbox, moon/planet shapes, stars, and ground shape.
- Overall layout: two-column.
- Left content takes around 50–55% width.
- Illustration takes around 45–50% width.
- Large empty spacing, not cramped.

## Layout - Mobile
- Header with logo and hamburger menu.
- Hero title at top.
- Illustration below title.
- Paragraph and feature row below illustration.
- Captcha/email section lower.
- Single-column layout.
- Keep same dark visual style.

## Components
- Button "Copy": filled blue.
- Button "Refresh": dark outline with subtle border.
- Email input: dark gray rectangle, copy icon on right.
- Main email card: dashed border, dark background, rounded corners.

## Strict Rules
- Do not redesign the page.
- Do not introduce new colors.
- Do not add extra sections.
- Do not add complex animations.
- Do not use default bright white background.
- Do not change the layout concept.
- Match the reference composition first, polish second.

## Acceptance Criteria
- Desktop screenshot should visually resemble the reference at first glance.
- Mobile screenshot should preserve the same order as the reference.
- Background, cards, buttons, text hierarchy, and spacing must match the design spec.