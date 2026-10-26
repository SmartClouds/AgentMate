<?php
/**
 * The few WordPress functions the admin views call, for rendering them in tests. The escaping
 * functions behave like WordPress's: esc_html and esc_attr do NOT double-encode existing
 * entities, which is exactly what made JavaScript inside attributes unsafe.
 *
 * @package Runova\Connector
 */

// phpcs:ignoreFile

if (!function_exists('esc_html')) {
    function esc_html($text)
    {
        return htmlspecialchars((string) $text, ENT_QUOTES, 'UTF-8', false);
    }
}
if (!function_exists('esc_attr')) {
    function esc_attr($text)
    {
        return htmlspecialchars((string) $text, ENT_QUOTES, 'UTF-8', false);
    }
}
if (!function_exists('esc_textarea')) {
    function esc_textarea($text)
    {
        return htmlspecialchars((string) $text, ENT_QUOTES, 'UTF-8');
    }
}
if (!function_exists('esc_url')) {
    function esc_url($url)
    {
        return htmlspecialchars((string) $url, ENT_QUOTES, 'UTF-8', false);
    }
}
if (!function_exists('__')) {
    function __($text, $domain = 'default')
    {
        return $text;
    }
}
if (!function_exists('esc_html__')) {
    function esc_html__($text, $domain = 'default')
    {
        return esc_html($text);
    }
}
if (!function_exists('esc_attr__')) {
    function esc_attr__($text, $domain = 'default')
    {
        return esc_attr($text);
    }
}
if (!function_exists('wp_nonce_field')) {
    function wp_nonce_field($action = -1)
    {
        echo '<input type="hidden" name="_wpnonce" value="0123456789">';
    }
}
if (!function_exists('wp_date')) {
    function wp_date($format, $timestamp = null)
    {
        return gmdate($format, (int) $timestamp);
    }
}
if (!function_exists('get_option')) {
    function get_option($name, $default = false)
    {
        return $name === 'date_format' ? 'Y-m-d' : ($name === 'time_format' ? 'H:i' : $default);
    }
}
if (!function_exists('disabled')) {
    function disabled($disabled)
    {
        echo $disabled ? ' disabled="disabled"' : '';
    }
}
if (!function_exists('submit_button')) {
    function submit_button($text = null)
    {
        echo '<input type="submit" class="button button-primary" value="' . esc_attr((string) $text) . '">';
    }
}
