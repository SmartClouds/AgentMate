<?php
/**
 * The HTML of the admin tabs. Everything printed is escaped where it is printed.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Admin;

use Runova\Connector\Protocol;

final class AdminViews
{
    /**
     * @param array<string, string> $urls tab => URL
     */
    public static function open(string $active, array $urls): void
    {
        $labels = array(
            'keys' => __('Keys', 'runova-connector'),
            'connections' => __('Connections', 'runova-connector'),
            'deploys' => __('Deploys', 'runova-connector'),
            'audit' => __('Audit log', 'runova-connector'),
            'status' => __('Status', 'runova-connector'),
        );
        ?>
        <div class="wrap">
            <h1><?php echo esc_html__('Runova Connector', 'runova-connector'); ?></h1>
            <nav class="nav-tab-wrapper" aria-label="<?php echo esc_attr__('Runova Connector sections', 'runova-connector'); ?>">
                <?php foreach ($labels as $tab => $label) : ?>
                    <a href="<?php echo esc_url($urls[$tab]); ?>" class="nav-tab<?php echo $tab === $active ? ' nav-tab-active' : ''; ?>"<?php echo $tab === $active ? ' aria-current="page"' : ''; ?>><?php echo esc_html($label); ?></a>
                <?php endforeach; ?>
            </nav>
        <?php
    }

    public static function close(): void
    {
        echo '</div>';
    }

    public static function notice(string $type, string $text): void
    {
        $class = $type === 'success' ? 'notice-success' : 'notice-error';
        echo '<div class="notice ' . esc_attr($class) . '"><p>' . esc_html($text) . '</p></div>';
    }

    /**
     * Shown while the connector still runs from its 1.63 folder. The Runova app moves it on its
     * own; this is for a site the app cannot reach.
     */
    public static function moveBox(bool $canChangeCode): void
    {
        ?>
        <div class="notice notice-info">
            <p><?php echo esc_html__('AgentMate is now Runova. This connector still runs from its old folder, and moves to its own the next time the Runova app connects. You can also move it now.', 'runova-connector'); // legacy-name ?></p>
            <?php if ($canChangeCode) : ?>
                <form method="post">
                    <?php wp_nonce_field(AdminActions::nonceAction(AdminActions::MIGRATE)); ?>
                    <input type="hidden" name="runova_connector_action" value="<?php echo esc_attr(AdminActions::MIGRATE); ?>">
                    <p><button type="submit" class="button"><?php echo esc_html__('Move to its own folder', 'runova-connector'); ?></button></p>
                </form>
            <?php endif; ?>
        </div>
        <?php
    }

    private static function when(?int $timestamp, string $none): string
    {
        if ($timestamp === null) {
            return $none;
        }
        return (string) wp_date(get_option('date_format') . ' ' . get_option('time_format'), $timestamp);
    }

    /**
     * The question a form asks before it submits, as plain data. The page's one script reads it;
     * nothing on these pages puts text into an event handler or a script, so a hostile label
     * (they come from other people) can never become code. esc_attr leaves existing entities as
     * they are, which is harmless in a data attribute and would not be in an onsubmit.
     */
    private static function confirmAttribute(string $question): string
    {
        return ' data-runova-confirm="' . esc_attr($question) . '"';
    }

    /**
     * @param array{key: string, expiresAt: int, scope: string}|null $created
     */
    public static function keys(?array $created, ?string $error, bool $canWrite): void
    {
        $minutes = (int) (Protocol::PAIRING_TTL_SECONDS / 60);
        ?>
        <p><?php echo esc_html__('Connect this site to the Runova app to pull its theme and plugin files into a project, and to deploy changes back. Each connection starts with a one-time key made here.', 'runova-connector'); ?></p>

        <?php if ($error !== null) : ?>
            <div class="notice notice-error"><p><?php echo esc_html($error); ?></p></div>
        <?php endif; ?>

        <?php if ($created !== null) : ?>
            <div class="notice notice-success runova-key-box">
                <p><strong><?php echo esc_html__('Copy this key now. It is shown only once.', 'runova-connector'); ?></strong></p>
                <textarea id="runova-connector-key" class="large-text code" rows="4" readonly autocomplete="off" spellcheck="false"><?php echo esc_textarea($created['key']); ?></textarea>
                <p>
                    <button type="button" class="button button-primary" id="runova-connector-copy" data-copied="<?php echo esc_attr__('Copied.', 'runova-connector'); ?>"><?php echo esc_html__('Copy key', 'runova-connector'); ?></button>
                    <span id="runova-connector-copied" aria-live="polite"></span>
                </p>
                <p id="runova-connector-countdown" data-seconds="<?php echo esc_attr((string) Protocol::PAIRING_TTL_SECONDS); ?>" data-left="<?php echo esc_attr__('It works once. Time left to paste it into Runova:', 'runova-connector'); ?>" data-expired="<?php echo esc_attr__('This key has expired. Create a new one.', 'runova-connector'); ?>">
                    <?php
                    /* translators: %d: minutes */
                    echo esc_html(sprintf(__('It works once, for the next %d minutes. In Runova, open Deploy, choose Connect a WordPress site, and paste it.', 'runova-connector'), $minutes));
                    ?>
                </p>
                <?php if ($created['scope'] === 'write') : ?>
                    <p><strong><?php echo esc_html__('This is a write key. It lets Runova change code on this site.', 'runova-connector'); ?></strong></p>
                <?php endif; ?>
            </div>
        <?php endif; ?>

        <h2><?php echo esc_html__('Create a connection key', 'runova-connector'); ?></h2>
        <form method="post">
            <?php wp_nonce_field(AdminActions::nonceAction(AdminActions::CREATE_KEY)); ?>
            <input type="hidden" name="runova_connector_action" value="<?php echo esc_attr(AdminActions::CREATE_KEY); ?>">
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><?php echo esc_html__('Access', 'runova-connector'); ?></th>
                    <td>
                        <fieldset>
                            <label><input type="radio" name="scope" value="read" checked> <?php echo esc_html__('Read only: Runova can list and download theme and plugin files.', 'runova-connector'); ?></label><br>
                            <label><input type="radio" name="scope" value="write" <?php disabled(!$canWrite); ?>> <?php echo esc_html__('Read and write: Runova can also deploy changes to theme and plugin files.', 'runova-connector'); ?></label>
                            <?php if (!$canWrite) : ?>
                                <p class="description"><?php echo esc_html__('Write keys need the rights to install plugins and themes.', 'runova-connector'); ?></p>
                            <?php else : ?>
                                <p class="description"><?php echo esc_html__('A write key lets Runova change code on this site. Only make one for a computer you trust.', 'runova-connector'); ?></p>
                            <?php endif; ?>
                        </fieldset>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="runova-connector-label"><?php echo esc_html__('Label', 'runova-connector'); ?></label></th>
                    <td>
                        <input type="text" id="runova-connector-label" name="label" class="regular-text" maxlength="100" autocomplete="off">
                        <p class="description"><?php echo esc_html__('Optional. Helps you tell connections apart, for example "Office laptop".', 'runova-connector'); ?></p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="runova-connector-expires"><?php echo esc_html__('Connection lasts', 'runova-connector'); ?></label></th>
                    <td>
                        <select id="runova-connector-expires" name="expires">
                            <option value="0"><?php echo esc_html__('Until revoked', 'runova-connector'); ?></option>
                            <option value="1"><?php echo esc_html__('1 day', 'runova-connector'); ?></option>
                            <option value="7"><?php echo esc_html__('7 days', 'runova-connector'); ?></option>
                            <option value="30"><?php echo esc_html__('30 days', 'runova-connector'); ?></option>
                            <option value="90"><?php echo esc_html__('90 days', 'runova-connector'); ?></option>
                            <option value="365"><?php echo esc_html__('1 year', 'runova-connector'); ?></option>
                        </select>
                    </td>
                </tr>
            </table>
            <?php submit_button(__('Create key', 'runova-connector')); ?>
        </form>
        <?php
    }

    /**
     * The pages' only script, enqueued as a fixed string: confirmations from data-runova-confirm,
     * and the copy button and countdown of a new key. It reads text from data attributes and
     * writes it with textContent, never as markup or code.
     */
    const SCRIPT = <<<'JS'
(function () {
    var forms = document.querySelectorAll('form[data-runova-confirm]');
    Array.prototype.forEach.call(forms, function (form) {
        form.addEventListener('submit', function (event) {
            if (!window.confirm(form.getAttribute('data-runova-confirm'))) {
                event.preventDefault();
            }
        });
    });
    var box = document.getElementById('runova-connector-key');
    var copy = document.getElementById('runova-connector-copy');
    var copied = document.getElementById('runova-connector-copied');
    var countdown = document.getElementById('runova-connector-countdown');
    if (!box || !copy || !copied || !countdown) {
        return;
    }
    var ends = Date.now() + parseInt(countdown.getAttribute('data-seconds'), 10) * 1000;
    copy.addEventListener('click', function () {
        var done = function () { copied.textContent = copy.getAttribute('data-copied'); };
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(box.value).then(done);
        } else {
            box.select();
            document.execCommand('copy');
            done();
        }
    });
    var tick = function () {
        var seconds = Math.max(0, Math.round((ends - Date.now()) / 1000));
        if (seconds === 0) {
            box.value = '';
            copy.disabled = true;
            countdown.textContent = countdown.getAttribute('data-expired');
            return;
        }
        var m = Math.floor(seconds / 60);
        var s = seconds % 60;
        countdown.textContent = countdown.getAttribute('data-left') + ' ' + m + ':' + (s < 10 ? '0' : '') + s;
        window.setTimeout(tick, 1000);
    };
    tick();
})();
JS;

    /**
     * @param array<int, array<string, mixed>> $connections
     */
    public static function connections(array $connections, int $now): void
    {
        ?>
        <p><?php echo esc_html__('Computers paired with this site. Revoking one stops it at once; Runova on that computer has to connect again with a new key.', 'runova-connector'); ?></p>
        <?php if (count($connections) === 0) : ?>
            <p><em><?php echo esc_html__('No connections yet. Create a key on the Keys tab.', 'runova-connector'); ?></em></p>
            <?php
            return;
        endif;
        ?>
        <table class="widefat striped">
            <thead>
                <tr>
                    <th scope="col"><?php echo esc_html__('Label', 'runova-connector'); ?></th>
                    <th scope="col"><?php echo esc_html__('Access', 'runova-connector'); ?></th>
                    <th scope="col"><?php echo esc_html__('Device', 'runova-connector'); ?></th>
                    <th scope="col"><?php echo esc_html__('Created', 'runova-connector'); ?></th>
                    <th scope="col"><?php echo esc_html__('Last seen', 'runova-connector'); ?></th>
                    <th scope="col"><?php echo esc_html__('Expires', 'runova-connector'); ?></th>
                    <th scope="col"><?php echo esc_html__('Status', 'runova-connector'); ?></th>
                    <th scope="col"><span class="screen-reader-text"><?php echo esc_html__('Actions', 'runova-connector'); ?></span></th>
                </tr>
            </thead>
            <tbody>
                <?php foreach ($connections as $connection) : ?>
                    <?php
                    $expired = $connection['expires_at'] !== null && $connection['expires_at'] <= $now;
                    if ($connection['revoked_at'] !== null) {
                        $status = __('Revoked', 'runova-connector');
                    } elseif ($expired) {
                        $status = __('Expired', 'runova-connector');
                    } else {
                        $status = __('Active', 'runova-connector');
                    }
                    $seen = $connection['last_seen_at'] === null
                        ? __('Not yet', 'runova-connector')
                        : self::when($connection['last_seen_at'], '') . ($connection['last_ip'] !== '' ? ' (' . $connection['last_ip'] . ')' : '');
                    ?>
                    <tr>
                        <td><?php echo esc_html($connection['label']); ?></td>
                        <td><?php echo esc_html($connection['scope'] === 'write' ? __('Read and write', 'runova-connector') : __('Read only', 'runova-connector')); ?></td>
                        <td><?php echo esc_html($connection['device_name']); ?></td>
                        <td><?php echo esc_html(self::when($connection['created_at'], '')); ?></td>
                        <td><?php echo esc_html($seen); ?></td>
                        <td><?php echo esc_html(self::when($connection['expires_at'], __('Never', 'runova-connector'))); ?></td>
                        <td><?php echo esc_html($status); ?></td>
                        <td>
                            <?php if ($connection['revoked_at'] === null && !$expired) : ?>
                                <form method="post"<?php echo self::confirmAttribute(sprintf(/* translators: %s: connection label */ __('Revoke "%s"? Runova on that computer will lose access to this site.', 'runova-connector'), $connection['label'])); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped inside confirmAttribute(). ?>>
                                    <?php wp_nonce_field(AdminActions::nonceAction(AdminActions::REVOKE, $connection['id'])); ?>
                                    <input type="hidden" name="runova_connector_action" value="<?php echo esc_attr(AdminActions::REVOKE); ?>">
                                    <input type="hidden" name="id" value="<?php echo esc_attr($connection['id']); ?>">
                                    <button type="submit" class="button button-link-delete"><?php echo esc_html__('Revoke', 'runova-connector'); ?></button>
                                </form>
                            <?php endif; ?>
                        </td>
                    </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
        <?php
    }

    private static function stateLabel(string $state, ?string $reason): string
    {
        $states = array(
            'open' => __('Open', 'runova-connector'),
            'applying' => __('Applying', 'runova-connector'),
            'applied' => __('Waiting for confirmation', 'runova-connector'),
            'done' => __('Done', 'runova-connector'),
            'rolledBack' => __('Rolled back', 'runova-connector'),
            'aborted' => __('Aborted', 'runova-connector'),
            'expired' => __('Expired', 'runova-connector'),
        );
        $reasons = array(
            'requested' => __('on request', 'runova-connector'),
            'healthCheck' => __('the site stopped answering properly', 'runova-connector'),
            'fatalError' => __('a fatal PHP error', 'runova-connector'),
            'notConfirmed' => __('not confirmed in time', 'runova-connector'),
            'interrupted' => __('interrupted', 'runova-connector'),
        );
        $label = isset($states[$state]) ? $states[$state] : $state;
        if ($reason !== null && isset($reasons[$reason])) {
            $label .= ' (' . $reasons[$reason] . ')';
        }
        return $label;
    }

    /**
     * @param array<int, array<string, mixed>> $records WpDeployRecord
     * @param array{deployId: string, state: string, deadline: int}|null $pending
     */
    public static function deploys(array $records, ?array $pending, bool $canChangeCode): void
    {
        ?>
        <p><?php echo esc_html__('The last 20 deploys from Runova. The five newest finished ones keep a copy of the files they replaced, so they can be rolled back while nothing has changed those files since.', 'runova-connector'); ?></p>
        <?php if ($pending !== null) : ?>
            <div class="notice notice-warning inline"><p>
                <?php
                /* translators: 1: state, 2: time */
                echo esc_html(sprintf(__('A deploy is in progress (%1$s). If it is not confirmed by %2$s it is rolled back.', 'runova-connector'), self::stateLabel($pending['state'], null), self::when($pending['deadline'], '')));
                ?>
            </p></div>
        <?php endif; ?>
        <?php if (count($records) === 0) : ?>
            <p><em><?php echo esc_html__('No deploys yet.', 'runova-connector'); ?></em></p>
            <?php
            return;
        endif;
        ?>
        <table class="widefat striped">
            <thead>
                <tr>
                    <th scope="col"><?php echo esc_html__('Deploy', 'runova-connector'); ?></th>
                    <th scope="col"><?php echo esc_html__('State', 'runova-connector'); ?></th>
                    <th scope="col"><?php echo esc_html__('Started', 'runova-connector'); ?></th>
                    <th scope="col"><?php echo esc_html__('Finished', 'runova-connector'); ?></th>
                    <th scope="col"><?php echo esc_html__('By', 'runova-connector'); ?></th>
                    <th scope="col"><?php echo esc_html__('Files', 'runova-connector'); ?></th>
                    <th scope="col"><span class="screen-reader-text"><?php echo esc_html__('Actions', 'runova-connector'); ?></span></th>
                </tr>
            </thead>
            <tbody>
                <?php foreach ($records as $record) : ?>
                    <tr>
                        <td><?php echo esc_html($record['label']); ?></td>
                        <td><?php echo esc_html(self::stateLabel($record['state'], isset($record['reason']) ? $record['reason'] : null)); ?></td>
                        <td><?php echo esc_html(self::when($record['startedAt'], '')); ?></td>
                        <td><?php echo esc_html(self::when($record['finishedAt'], __('Not yet', 'runova-connector'))); ?></td>
                        <td><?php echo esc_html($record['connectionLabel']); ?></td>
                        <td>
                            <?php
                            /* translators: 1: files written, 2: files deleted */
                            echo esc_html(sprintf(__('%1$d written, %2$d deleted', 'runova-connector'), $record['puts'], $record['deletes']));
                            ?>
                        </td>
                        <td>
                            <?php if ($record['canRollback'] && $canChangeCode) : ?>
                                <form method="post"<?php echo self::confirmAttribute(sprintf(/* translators: %s: deploy label */ __('Roll back "%s"? The files it changed go back to how they were before it.', 'runova-connector'), $record['label'])); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped inside confirmAttribute(). ?>>
                                    <?php wp_nonce_field(AdminActions::nonceAction(AdminActions::ROLLBACK, $record['deployId'])); ?>
                                    <input type="hidden" name="runova_connector_action" value="<?php echo esc_attr(AdminActions::ROLLBACK); ?>">
                                    <input type="hidden" name="id" value="<?php echo esc_attr($record['deployId']); ?>">
                                    <button type="submit" class="button"><?php echo esc_html__('Roll back', 'runova-connector'); ?></button>
                                </form>
                            <?php endif; ?>
                        </td>
                    </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
        <?php
    }

    /**
     * @param array<int, array<string, mixed>> $entries WpAuditEntry
     */
    public static function audit(array $entries, ?string $olderUrl, ?string $newestUrl): void
    {
        $events = array(
            'keyCreated' => __('Key created', 'runova-connector'),
            'paired' => __('Paired', 'runova-connector'),
            'pairFailed' => __('Pairing refused', 'runova-connector'),
            'authFailed' => __('Request refused', 'runova-connector'),
            'rateLimited' => __('Address locked out', 'runova-connector'),
            'revoked' => __('Connection revoked', 'runova-connector'),
            'pulled' => __('Files listed', 'runova-connector'),
            'deployStarted' => __('Deploy started', 'runova-connector'),
            'deployDone' => __('Deploy done', 'runova-connector'),
            'deployRolledBack' => __('Deploy rolled back', 'runova-connector'),
            'deployAborted' => __('Deploy aborted', 'runova-connector'),
            'connectorUpdated' => __('Connector updated', 'runova-connector'),
            'connectorRolledBack' => __('Connector update undone', 'runova-connector'),
            'settingsChanged' => __('Settings changed', 'runova-connector'),
        );
        ?>
        <p><?php echo esc_html__('The newest 2,000 events: pairings, pulls, deploys, rollbacks and refused requests.', 'runova-connector'); ?></p>
        <?php if (count($entries) === 0) : ?>
            <p><em><?php echo esc_html__('Nothing logged yet.', 'runova-connector'); ?></em></p>
        <?php else : ?>
            <table class="widefat striped">
                <thead>
                    <tr>
                        <th scope="col"><?php echo esc_html__('When', 'runova-connector'); ?></th>
                        <th scope="col"><?php echo esc_html__('Event', 'runova-connector'); ?></th>
                        <th scope="col"><?php echo esc_html__('Connection', 'runova-connector'); ?></th>
                        <th scope="col"><?php echo esc_html__('Address', 'runova-connector'); ?></th>
                        <th scope="col"><?php echo esc_html__('Details', 'runova-connector'); ?></th>
                    </tr>
                </thead>
                <tbody>
                    <?php foreach ($entries as $entry) : ?>
                        <tr>
                            <td><?php echo esc_html(self::when($entry['at'], '')); ?></td>
                            <td><?php echo esc_html(isset($events[$entry['event']]) ? $events[$entry['event']] : $entry['event']); ?></td>
                            <td><?php echo esc_html($entry['connectionLabel'] !== null ? $entry['connectionLabel'] : ''); ?></td>
                            <td><?php echo esc_html($entry['ip']); ?></td>
                            <td><?php echo esc_html($entry['detail']); ?></td>
                        </tr>
                    <?php endforeach; ?>
                </tbody>
            </table>
        <?php endif; ?>
        <p>
            <?php if ($newestUrl !== null) : ?>
                <a class="button" href="<?php echo esc_url($newestUrl); ?>"><?php echo esc_html__('Newest', 'runova-connector'); ?></a>
            <?php endif; ?>
            <?php if ($olderUrl !== null) : ?>
                <a class="button" href="<?php echo esc_url($olderUrl); ?>"><?php echo esc_html__('Older entries', 'runova-connector'); ?></a>
            <?php endif; ?>
        </p>
        <?php
    }

    /**
     * @param array<int, array{id: string, label: string, ok: bool|null, detail: string}> $checks
     */
    public static function status(array $checks): void
    {
        ?>
        <p><?php echo esc_html__('What this site allows, and what protects a deploy here. The loopback check runs each time this tab opens.', 'runova-connector'); ?></p>
        <table class="widefat striped">
            <tbody>
                <?php foreach ($checks as $check) : ?>
                    <?php
                    if ($check['ok'] === true) {
                        $icon = 'dashicons-yes-alt';
                        $word = __('OK', 'runova-connector');
                        $color = '#00a32a';
                    } elseif ($check['ok'] === false) {
                        $icon = 'dashicons-warning';
                        $word = __('Problem', 'runova-connector');
                        $color = '#d63638';
                    } else {
                        $icon = 'dashicons-info';
                        $word = __('Note', 'runova-connector');
                        $color = '#646970';
                    }
                    ?>
                    <tr data-check="<?php echo esc_attr($check['id']); ?>">
                        <th scope="row"><?php echo esc_html($check['label']); ?></th>
                        <td><span class="dashicons <?php echo esc_attr($icon); ?>" style="color: <?php echo esc_attr($color); ?>" aria-hidden="true"></span> <?php echo esc_html($word); ?></td>
                        <td><?php echo esc_html($check['detail']); ?></td>
                    </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
        <?php
    }
}
