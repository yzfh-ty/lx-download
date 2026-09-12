/**
 * Common UI & Initialization Helpers
 */

(function () {
    // --- Setting Tooltips Mobile Support ---
    document.addEventListener('click', function (e) {
        const trigger = e.target.closest('.setting-tooltip-trigger');

        // Close all other tooltips
        document.querySelectorAll('.setting-tooltip-trigger.is-active').forEach(activeTrigger => {
            if (activeTrigger !== trigger) {
                activeTrigger.classList.remove('is-active');
            }
        });

        if (trigger) {
            // If it's a mobile device (or doesn't support hover)
            if (window.matchMedia('(hover: none)').matches) {
                trigger.classList.toggle('is-active');
                e.stopPropagation();
            }
        }
    });

    // Close tooltip when clicking outside
    document.addEventListener('touchstart', function (e) {
        if (!e.target.closest('.setting-tooltip-trigger')) {
            document.querySelectorAll('.setting-tooltip-trigger.is-active').forEach(trigger => {
                trigger.classList.remove('is-active');
            });
        }
    }, { passive: true });
})();

/**
 * 跳转至管理后台
 */


