let _isMobile: boolean | null = null;

/**
 * Detect a touch-primary device (phone or tablet) regardless of UA.
 *
 * Why not just regex navigator.userAgent: iPadOS 13+ Safari ships with
 * "Request Desktop Website" enabled by default, and the resulting UA
 * looks like a Mac — no "iPad" substring at all. Hundreds of millions
 * of iPad users were getting the desktop editor (scene hierarchy,
 * properties panel, asset library) because the regex missed them. The
 * reliable detection is capability-based:
 *
 *   - touch present: ontouchstart || maxTouchPoints > 0
 *   - primary pointer is coarse: matchMedia('(pointer: coarse)')
 *
 * Both are needed. Touch alone matches Surface laptops with a touchscreen
 * (where the user really wants the desktop UI). Coarse alone could hit
 * obscure non-touch coarse-pointer devices. The intersection is exactly
 * "phone or tablet whose user is going to use a finger." This is the
 * same predicate the engine's shouldShowMobileOverlay() uses.
 */
export function isMobile(): boolean {
    if (_isMobile === null) {
        const hasTouch = ('ontouchstart' in window)
            || ((navigator as any)?.maxTouchPoints ?? 0) > 0;
        const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
        _isMobile = hasTouch && coarse;
    }
    return _isMobile;
}
