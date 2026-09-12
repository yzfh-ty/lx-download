/**
 * Theme Manager & Settings UI Logic
 */

// Available Themes
const THEMES = ['emerald', 'blue', 'amber', 'violet', 'rose'];

// Initialize Theme & Appearance
function initTheme() {
    const savedTheme = localStorage.getItem('lx_theme') || 'emerald';
    const savedAppearance = localStorage.getItem('lx_appearance') || 'system';

    setTheme(savedTheme, false);
    setAppearance(savedAppearance, false);
}

// Set Theme (Colors)
function setTheme(themeName, save = true) {
    if (!THEMES.includes(themeName)) return;

    // Apply to Body
    document.documentElement.setAttribute('data-theme', themeName);

    // Save Preference
    if (save) {
        localStorage.setItem('lx_theme', themeName);
        console.log(`[Theme] Color scheme applied: ${themeName}`);
    }

    // Update UI (Checkmarks and Highlights)
    updateThemeSelectionUI(themeName);
}

function setAppearance(mode, save = true) {
    const validModes = ['light', 'dark', 'system'];
    if (!validModes.includes(mode)) return;

    // Apply to Root
    if (mode === 'system') {
        document.documentElement.removeAttribute('data-appearance');
        // Apply class based on matchMedia
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (isDark) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    } else {
        document.documentElement.setAttribute('data-appearance', mode);
        if (mode === 'dark') {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    }

    // Save Preference
    if (save) {
        localStorage.setItem('lx_appearance', mode);
        console.log(`[Theme] Appearance mode applied: ${mode}`);
    }

    // Update UI in settings
    updateAppearanceUI(mode);
}

function updateThemeSelectionUI(activeTheme) {
    document.querySelectorAll('.theme-option').forEach(btn => {
        const theme = btn.getAttribute('data-theme');
        if (theme === activeTheme) {
            btn.setAttribute('data-active', 'true');
        } else {
            btn.setAttribute('data-active', 'false');
        }
    });
}

function updateAppearanceUI(activeMode) {
    document.querySelectorAll('.appearance-option').forEach(btn => {
        const mode = btn.getAttribute('data-appearance');
        if (mode === activeMode) {
            btn.classList.add('ring-emerald-500', 'border-emerald-500', 'text-emerald-600');
            btn.classList.remove('t-border-main', 't-text-muted');
        } else {
            btn.classList.remove('ring-emerald-500', 'border-emerald-500', 'text-emerald-600');
            btn.classList.add('t-border-main', 't-text-muted');
        }
    });
}

function switchSettingsTab(tabName) {
    const panels = ['system', 'display', 'logs'];
    const pageHeading = {
        system: ['系统设置', '管理应用的下载、音质与服务行为。'],
        display: ['显示设置', '调整主题、外观和界面布局偏好。'],
        logs: ['系统日志', '查看服务运行期间记录的 Console 输出。']
    };

    // Deactivate all setting panels first
    panels.forEach(p => {
        const panel = document.getElementById(`settings-panel-${p}`);
        if (panel) panel.classList.add('hidden');
    });

    // Activate the selected panel; its navigation item is managed by switchTab.
    const activePanel = document.getElementById(`settings-panel-${tabName}`);
    if (activePanel) {
        activePanel.classList.remove('hidden');
    }

    const headingTitle = document.getElementById('settings-page-heading-title');
    const headingDescription = document.getElementById('settings-page-heading-description');
    const heading = pageHeading[tabName] || pageHeading.system;
    if (headingTitle) headingTitle.querySelector('span').textContent = heading[0];
    if (headingDescription) headingDescription.textContent = heading[1];

    // Special logic for logs
    if (tabName === 'logs' && window.renderSystemLogs) {
        window.renderSystemLogs();
    }
}

// Watch for system theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    const currentAppearance = localStorage.getItem('lx_appearance') || 'system';
    if (currentAppearance === 'system') {
        if (e.matches) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
        console.log(`[Theme] System color scheme changed to ${e.matches ? 'dark' : 'light'}`);
    }
});

// Initialize on Load
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
});
