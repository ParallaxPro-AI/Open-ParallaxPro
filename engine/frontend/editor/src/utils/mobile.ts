let _isMobile: boolean | null = null;

export function isMobile(): boolean {
    if (_isMobile === null) {
        _isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
            && 'ontouchstart' in window;
    }
    return _isMobile;
}
