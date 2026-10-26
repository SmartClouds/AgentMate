import {
  clampDesktopPetClickArea,
  clampDesktopPetScale,
  type DesktopPetCardView,
  isAnimatedPetFile,
  normalizeDesktopPetActionSpeeds,
  normalizeDesktopPetCardView,
  normalizeDesktopPetId,
  normalizeDesktopPetName,
  petBoxSize,
  petClickRect,
} from '@runova/core';
import { type PetPipelineMessage, type PetWorkArea, pipelineRunRoute } from '@shared/pet';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ExternalLink } from '@/components/icons';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { chuteFitFor, resolvePet, ropeGripYFor } from './characters';
import {
  type ActionSpeeds,
  type Actor,
  applyBox,
  clampActor,
  hopActor,
  mirrorsSprite,
  type Stage,
  spawnCompanion,
  stepCompanion,
} from './flock';
import { PetChute } from './PetChute';
import { MENU_H, MENU_W, PetMenu, placePetMenu } from './PetMenu';
import { CARD_H, CARD_W, PetStatsCard, placePetCard } from './PetStatsCard';

function speedsFromSettings(value: unknown): ActionSpeeds {
  const pct = normalizeDesktopPetActionSpeeds(value);
  return {
    walk: pct.walk / 100,
    climb: pct.climb / 100,
    descend: pct.descend / 100,
    parachute: pct.parachute / 100,
  };
}

function stageFromArea(area: PetWorkArea): Stage {
  return { width: area.width, height: area.height };
}

function snapshot(actor: Actor): Actor {
  return { ...actor, rope: actor.rope ? { ...actor.rope } : null };
}

const SPEECH_W = 220;
const SPEECH_H = 96;
/** A failure bubble carries an extra "open the run" line, so it sits taller. */
const SPEECH_LINK_H = 24;
/** Two clicks closer together than this open the app instead of the token card. */
const DOUBLE_CLICK_MS = 260;

/** The run a bubble points at, or null when it is only a message. */
function runRefOf(message: PetPipelineMessage | null): PetPipelineMessage['run'] | null {
  return message?.run ?? null;
}

function speechHeightFor(message: PetPipelineMessage | null): number {
  return runRefOf(message) ? SPEECH_H + SPEECH_LINK_H : SPEECH_H;
}

function speechRectFor(
  hit: { x: number; y: number; w: number; h: number },
  area: PetWorkArea,
  message: PetPipelineMessage | null,
): { x: number; y: number; w: number; h: number; below: boolean } {
  const height = speechHeightFor(message);
  const below = hit.y < 102;
  const x = Math.min(
    Math.max(8, hit.x + hit.w / 2 - SPEECH_W / 2),
    Math.max(8, area.width - SPEECH_W - 8),
  );
  const y = below ? hit.y + hit.h + 8 : Math.max(8, hit.y - height - 10);
  return { x, y, w: SPEECH_W, h: height, below };
}

/**
 * Full-screen transparent overlay for the chosen companion. Clicks pass through
 * empty space. Click the character for a token report.
 */
export default function DesktopPetRoute(): React.JSX.Element {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });
  const customImages = useQuery({
    queryKey: queryKeys.petCustomImages,
    queryFn: () => window.runova.pet.customDataUrls(),
  });

  const customs = settingsQuery.data?.desktopPetCustoms ?? [];
  const characterId = normalizeDesktopPetId(
    settingsQuery.data?.desktopPetCharacterId,
    customs.map((pet) => pet.id),
  );
  const canMove = settingsQuery.data?.desktopPetCanMove !== false;
  // Some sprites are drawn facing left, so the mirror has to run the other way.
  const flipped = settingsQuery.data?.desktopPetFlippedIds?.includes(characterId) === true;
  const canClimb = settingsQuery.data?.desktopPetCanClimb !== false;
  const canParachute = settingsQuery.data?.desktopPetCanParachute === true;
  const gear3d = settingsQuery.data?.desktopPetGear3d === true;
  const actionSpeeds = speedsFromSettings(settingsQuery.data?.desktopPetActionSpeeds);
  const scale = clampDesktopPetScale(settingsQuery.data?.desktopPetScale);
  const clickArea = clampDesktopPetClickArea(settingsQuery.data?.desktopPetClickArea);
  const cardView = normalizeDesktopPetCardView(settingsQuery.data?.desktopPetCardView);
  const box = petBoxSize(scale);
  const custom = customs.find((item) => item.id === characterId);
  const nickname = normalizeDesktopPetName(settingsQuery.data?.desktopPetName);
  const character = resolvePet(
    characterId,
    custom && customImages.data?.[custom.id]
      ? {
          name: custom.name,
          src: customImages.data[custom.id],
          animated: isAnimatedPetFile(custom.fileName),
        }
      : null,
  );
  // The nickname stands in for the character's name everywhere it is shown: the
  // stats card header and the right-click menu.
  const pet = character && nickname ? { ...character, name: nickname } : character;
  const spriteH = pet ? Math.round(pet.height * (scale / 100)) : box;
  const ropeGripY = pet ? ropeGripYFor(pet) : 0.5;
  const chuteFit = pet ? chuteFitFor(pet) : null;

  const [actor, setActor] = useState<Actor | null>(null);
  const [drawn, setDrawn] = useState({ w: 0, h: spriteH });
  const [open, setOpen] = useState(false);
  const [speech, setSpeech] = useState<PetPipelineMessage | null>(null);
  const [dragging, setDragging] = useState(false);
  const [cardSize, setCardSize] = useState({ w: CARD_W, h: CARD_H });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [menuSize, setMenuSize] = useState({ w: MENU_W, h: MENU_H });
  const actorRef = useRef<Actor | null>(null);
  const areaRef = useRef<PetWorkArea>({ x: 0, y: 0, width: 0, height: 0 });
  const openRef = useRef(false);
  const menuRef = useRef(false);
  const menuElRef = useRef<HTMLDivElement>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechRef = useRef<PetPipelineMessage | null>(null);
  const speechTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const hitRef = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const spriteRef = useRef<HTMLImageElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const ropeRef = useRef<HTMLDivElement>(null);
  const speechElRef = useRef<HTMLDivElement>(null);
  const spriteHRef = useRef(spriteH);
  const drawnRef = useRef(drawn);
  const configRef = useRef({
    canMove,
    canClimb,
    canParachute,
    box,
    characterId,
    spriteH,
    ropeGripY,
    speeds: actionSpeeds,
    clickArea,
  });

  openRef.current = open;
  menuRef.current = menu !== null;
  speechRef.current = speech;
  drawnRef.current = drawn;
  configRef.current = {
    canMove,
    canClimb,
    canParachute,
    box,
    characterId,
    spriteH: spriteHRef.current,
    ropeGripY,
    speeds: actionSpeeds,
    clickArea,
  };

  function hitRectFor(current: Actor): { x: number; y: number; w: number; h: number } {
    const drawnNow = drawnRef.current;
    return petClickRect(
      current.x,
      current.y,
      current.box,
      drawnNow.w || current.box,
      drawnNow.h || spriteHRef.current || current.box,
      configRef.current.clickArea,
    );
  }

  function applyPose(current: Actor): void {
    const body = bodyRef.current;
    if (body) {
      body.style.left = `${current.x}px`;
      body.style.top = `${current.y}px`;
      body.style.width = `${current.box}px`;
      body.style.height = `${current.box}px`;
    }
    const rope = ropeRef.current;
    if (rope && current.rope) {
      const top = Math.min(current.rope.fromY, current.rope.toY);
      rope.style.left = `${current.rope.x}px`;
      rope.style.top = `${top}px`;
      rope.style.height = `${Math.max(8, Math.abs(current.rope.toY - current.rope.fromY))}px`;
    }
    const bubble = speechElRef.current;
    if (bubble) {
      const rect = speechRectFor(hitRectFor(current), areaRef.current, speechRef.current);
      bubble.style.left = `${rect.x}px`;
      bubble.style.top = `${rect.y}px`;
      bubble.classList.toggle('is-below', rect.below);
      bubble.classList.toggle('is-above', !rect.below);
    }
  }

  function hitSpeech(clientX: number, clientY: number): boolean {
    if (!speechRef.current || !actorRef.current) return false;
    const rect = speechRectFor(hitRectFor(actorRef.current), areaRef.current, speechRef.current);
    return (
      clientX >= rect.x &&
      clientX <= rect.x + rect.w &&
      clientY >= rect.y &&
      clientY <= rect.y + rect.h
    );
  }

  function measureSprite(img: HTMLImageElement | null): void {
    if (!img) return;
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;
    const elW = img.clientWidth || box;
    const elH = img.clientHeight || spriteH;
    const fit = natW > 0 && natH > 0 ? Math.min(elW / natW, elH / natH) : 1;
    const nextH = Math.max(8, natH > 0 ? natH * fit : spriteH);
    const nextW = Math.max(8, natW > 0 ? natW * fit : nextH);
    spriteHRef.current = nextH;
    configRef.current = { ...configRef.current, spriteH: nextH, ropeGripY };
    setDrawn((prev) =>
      Math.abs(prev.w - nextW) < 0.5 && Math.abs(prev.h - nextH) < 0.5
        ? prev
        : { w: nextW, h: nextH },
    );
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new character, size or image has to be re-measured; measureSprite is rebuilt every render and would re-run this constantly
  useLayoutEffect(() => {
    spriteHRef.current = spriteH;
    configRef.current = { ...configRef.current, spriteH, ropeGripY };
    setDrawn({ w: 0, h: spriteH });
    measureSprite(spriteRef.current);
  }, [characterId, spriteH, box, pet?.src, ropeGripY]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: applyPose reads the new click area and box through configRef, so those are the triggers; applyPose itself only touches refs
  useLayoutEffect(() => {
    const current = actorRef.current;
    if (!current) return;
    applyPose(current);
    setActor(snapshot(current));
  }, [clickArea, box]);

  // Everything that holds the mouse goes through setHit, so the overlay always
  // knows whether it is currently taking clicks. Poking the main process
  // directly here used to leave the two out of step, and a mouse that never
  // came back over the character left the whole screen swallowing clicks.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setHit only touches a ref and the main process, it is safe to call from a stale closure
  useEffect(() => {
    if (open) setHit(true);
    else {
      setHit(menuRef.current);
      setCardSize({ w: CARD_W, h: CARD_H });
    }
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setHit only touches a ref and the main process, it is safe to call from a stale closure
  useEffect(() => {
    if (!menu) {
      setMenuSize({ w: MENU_W, h: MENU_H });
      setHit(openRef.current);
      return;
    }
    setHit(true);
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setMenu(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menu]);

  useLayoutEffect(() => {
    const node = menuElRef.current;
    if (!menu || !node) return;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return;
    setMenuSize((prev) =>
      prev.w === Math.ceil(rect.width) && prev.h === Math.ceil(rect.height)
        ? prev
        : { w: Math.ceil(rect.width), h: Math.ceil(rect.height) },
    );
  }, [menu]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different character changes the card's contents, so it has to be measured again
  useLayoutEffect(() => {
    if (!open) return;
    const node = cardRef.current;
    if (!node) return;
    const target: HTMLDivElement = node;
    function apply(): void {
      const rect = target.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;
      setCardSize((prev) =>
        prev.w === Math.ceil(rect.width) && prev.h === Math.ceil(rect.height)
          ? prev
          : { w: Math.ceil(rect.width), h: Math.ceil(rect.height) },
      );
    }
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(target);
    return () => observer.disconnect();
  }, [open, characterId]);

  useEffect(() => {
    document.documentElement.setAttribute('data-widget', '');
    return () => document.documentElement.removeAttribute('data-widget');
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: applyPose only touches refs, so resubscribing every render for it would gain nothing
  useEffect(() => {
    return window.runova.pet.onSettingsChanged(() => {
      void (async () => {
        const settings = await window.runova.settings.get();
        queryClient.setQueryData(queryKeys.settings, settings);
        const nextBox = petBoxSize(clampDesktopPetScale(settings.desktopPetScale));
        const nextClickArea = clampDesktopPetClickArea(settings.desktopPetClickArea);
        const nextId = normalizeDesktopPetId(
          settings.desktopPetCharacterId,
          (settings.desktopPetCustoms ?? []).map((pet) => pet.id),
        );
        configRef.current = {
          ...configRef.current,
          canMove: settings.desktopPetCanMove !== false,
          canClimb: settings.desktopPetCanClimb !== false,
          canParachute: settings.desktopPetCanParachute === true,
          speeds: speedsFromSettings(settings.desktopPetActionSpeeds),
          box: nextBox,
          clickArea: nextClickArea,
          characterId: nextId,
        };
        const current = actorRef.current;
        if (current) {
          applyBox(current, stageFromArea(areaRef.current), nextBox);
          applyPose(current);
          setActor(snapshot(current));
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.petCustomImages });
      })();
    });
  }, [queryClient]);

  useEffect(() => {
    return window.runova.pet.onPipelineMessage((payload) => {
      setSpeech(payload);
      const current = actorRef.current;
      if (current) {
        hopActor(current, performance.now());
        setActor(snapshot(current));
      }
      if (speechTimer.current) clearTimeout(speechTimer.current);
      speechTimer.current = setTimeout(() => setSpeech(null), 8000);
    });
  }, []);

  // The overlay only covers the primary display's work area, so a cursor that
  // wanders onto another monitor or over the taskbar stops sending it moves. If
  // it was holding the mouse at that moment it would hold it for good, and
  // every click and drag in the app below would land on the pet instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setHit only touches a ref and the main process, it is safe to call from a stale closure
  useEffect(() => {
    function onLeave(): void {
      if (dragRef.current || openRef.current || menuRef.current) return;
      setHit(false);
    }
    document.addEventListener('mouseleave', onLeave);
    window.addEventListener('blur', onLeave);
    return () => {
      document.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('blur', onLeave);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (speechTimer.current) clearTimeout(speechTimer.current);
      if (clickTimer.current) clearTimeout(clickTimer.current);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the animation loop runs once per mount and reads everything through refs; applyPose only touches refs too
  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    let lastTs = 0;
    let poseKey = '';

    function sync(next: Actor, force = false): void {
      actorRef.current = next;
      applyPose(next);
      const key = `${next.action}:${next.facing}:${next.rope ? 1 : 0}:${next.box}:${next.id}:${configRef.current.clickArea}`;
      if (!force && key === poseKey) return;
      poseKey = key;
      setActor(snapshot(next));
    }

    async function boot(): Promise<void> {
      const [area, settings] = await Promise.all([
        window.runova.pet.getWorkArea(),
        window.runova.settings.get(),
      ]);
      if (cancelled) return;
      areaRef.current = area;
      const characterId = normalizeDesktopPetId(
        settings.desktopPetCharacterId,
        (settings.desktopPetCustoms ?? []).map((pet) => pet.id),
      );
      const canMove = settings.desktopPetCanMove !== false;
      const box = petBoxSize(clampDesktopPetScale(settings.desktopPetScale));
      configRef.current = {
        ...configRef.current,
        canMove,
        canClimb: settings.desktopPetCanClimb !== false,
        canParachute: settings.desktopPetCanParachute === true,
        speeds: speedsFromSettings(settings.desktopPetActionSpeeds),
        box,
        characterId,
        clickArea: clampDesktopPetClickArea(settings.desktopPetClickArea),
      };
      sync(spawnCompanion(stageFromArea(area), characterId, box, canMove), true);
      lastTs = 0;
      frame = requestAnimationFrame(tick);
    }

    function tick(ts: number): void {
      if (cancelled) return;
      frame = requestAnimationFrame(tick);
      const dt = lastTs === 0 ? 0 : Math.min(0.1, (ts - lastTs) / 1000);
      lastTs = ts;
      const current = actorRef.current;
      if (!current || dt === 0) return;
      const cfg = configRef.current;
      if (current.id !== cfg.characterId) current.id = cfg.characterId;
      applyBox(current, stageFromArea(areaRef.current), cfg.box);
      const paused = openRef.current || menuRef.current || dragRef.current !== null;
      stepCompanion(current, stageFromArea(areaRef.current), dt, ts, paused, cfg);
      sync(current);
    }

    void boot();
    const unsubscribe = window.runova.pet.onDisplayChanged((area) => {
      areaRef.current = area;
      if (actorRef.current) {
        clampActor(actorRef.current, stageFromArea(area));
        sync(actorRef.current);
      }
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      unsubscribe();
      window.runova.pet.setClickThrough(true);
    };
  }, []);

  function setHit(next: boolean): void {
    if (hitRef.current === next) return;
    hitRef.current = next;
    window.runova.pet.setClickThrough(!next);
  }

  function hitTest(clientX: number, clientY: number): boolean {
    const current = actorRef.current;
    if (!current) return false;
    const hit = hitRectFor(current);
    return (
      clientX >= hit.x && clientX <= hit.x + hit.w && clientY >= hit.y && clientY <= hit.y + hit.h
    );
  }

  function insideMenu(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('[data-pet-hit="menu"]') !== null;
  }

  /**
   * The card sits outside the pet's hit box, so without this its own controls
   * (the view tabs) would read as a click on empty space and close it.
   */
  function insideCard(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('[data-pet-hit="card"]') !== null;
  }

  /**
   * Raises the app window. When the pet is still showing a failed run, the app
   * lands on that run in Pipelines instead of wherever it was left.
   */
  function openApp(): void {
    const run = runRefOf(speechRef.current);
    window.runova.pet.showMainWindow(run ? pipelineRunRoute(run) : undefined);
  }

  function dismissSpeech(): void {
    if (speechTimer.current) clearTimeout(speechTimer.current);
    speechTimer.current = null;
    setSpeech(null);
  }

  /** Drops a click that was waiting to see whether a double click followed. */
  function cancelPendingClick(): void {
    if (!clickTimer.current) return;
    clearTimeout(clickTimer.current);
    clickTimer.current = null;
  }

  function onContextMenu(event: React.MouseEvent<HTMLDivElement>): void {
    event.preventDefault();
    if (insideMenu(event.target) || insideCard(event.target)) return;
    if (!actorRef.current || !hitTest(event.clientX, event.clientY)) {
      setMenu(null);
      return;
    }
    cancelPendingClick();
    setOpen(false);
    setMenu({ x: event.clientX, y: event.clientY });
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (insideMenu(event.target) || insideCard(event.target)) return;
    if (event.button !== 0) return;
    const current = actorRef.current;
    if (menuRef.current) {
      setMenu(null);
      return;
    }
    if (hitSpeech(event.clientX, event.clientY)) {
      cancelPendingClick();
      // A failure bubble is a link to the run it announced; anything else just
      // gets waved away.
      const run = runRefOf(speechRef.current);
      dismissSpeech();
      if (run) {
        setOpen(false);
        setMenu(null);
        window.runova.pet.showMainWindow(pipelineRunRoute(run));
      }
      return;
    }
    if (!current || !hitTest(event.clientX, event.clientY)) {
      cancelPendingClick();
      setOpen(false);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      dx: event.clientX - current.x,
      dy: event.clientY - current.y,
      moved: false,
    };
    setDragging(true);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    const current = actorRef.current;
    if (!drag) {
      setHit(
        hitTest(event.clientX, event.clientY) ||
          hitSpeech(event.clientX, event.clientY) ||
          openRef.current ||
          menuRef.current,
      );
      return;
    }
    if (!current) return;
    const x = event.clientX - drag.dx;
    const y = event.clientY - drag.dy;
    if (Math.abs(x - current.x) > 3 || Math.abs(y - current.y) > 3) drag.moved = true;
    current.x = x;
    current.y = y;
    current.vx = 0;
    clampActor(current, stageFromArea(areaRef.current));
    applyPose(current);
    setActor(snapshot(current));
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const current = actorRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!current) return;
    if (!drag.moved) {
      hopActor(current, performance.now());
      // A second click before the timer runs out is a double click, which opens
      // the app instead of the token card.
      if (clickTimer.current) {
        cancelPendingClick();
        setOpen(false);
        openApp();
        return;
      }
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null;
        setOpen((value) => !value);
      }, DOUBLE_CLICK_MS);
      return;
    }
    current.rope = null;
    current.action = 'idle';
    current.nextAt = configRef.current.canMove
      ? performance.now() + 2800 + Math.random() * 6000
      : performance.now() + 60_000;
  }

  function handleOpenApp(): void {
    setMenu(null);
    openApp();
  }

  function handleToggleMove(): void {
    setMenu(null);
    void window.runova.settings.update({ desktopPetCanMove: !canMove });
  }

  function handleSelectCardView(next: DesktopPetCardView): void {
    // Painted from the cache right away so the tab switches under the cursor;
    // the saved value comes back through onSettingsChanged a moment later.
    queryClient.setQueryData<Awaited<ReturnType<typeof window.runova.settings.get>>>(
      queryKeys.settings,
      (prev) => (prev ? { ...prev, desktopPetCardView: next } : prev),
    );
    void window.runova.settings.update({ desktopPetCardView: next });
  }

  function handleSnooze(minutes: number): void {
    setMenu(null);
    void window.runova.pet.snooze(minutes);
  }

  function handleTurnOff(): void {
    setMenu(null);
    void window.runova.settings.update({ desktopPetEnabled: false });
  }

  const hit = actor ? hitRectFor(actor) : null;
  const placement =
    actor && hit
      ? placePetCard(
          hit.x,
          hit.y,
          hit.w,
          hit.h,
          areaRef.current.width,
          areaRef.current.height,
          cardSize.w,
          cardSize.h,
        )
      : null;

  const bubble = actor && speech && hit ? speechRectFor(hit, areaRef.current, speech) : null;
  const bubbleBelow = bubble?.below ?? false;

  const chute =
    actor && chuteFit && actor.action === 'parachute'
      ? {
          box: actor.box,
          spriteW: drawn.w || Math.round((drawn.h || spriteH) * 0.85),
          spriteH: drawn.h || spriteH,
          fit: chuteFit,
        }
      : null;

  return (
    <div
      className="desktop-pet-stage relative h-full w-full overflow-hidden"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
    >
      {actor?.rope ? (
        <div
          ref={ropeRef}
          className={cn('pet-rope', gear3d && 'is-3d')}
          style={{
            left: actor.rope.x,
            top: Math.min(actor.rope.fromY, actor.rope.toY),
            height: Math.max(8, Math.abs(actor.rope.toY - actor.rope.fromY)),
          }}
          aria-hidden
        >
          <span className="pet-rope-cord" />
          <span className="pet-rope-hook is-start" />
          <span className="pet-rope-hook is-end" />
        </div>
      ) : null}

      {actor && pet ? (
        <div
          ref={bodyRef}
          data-pet-hit="sprite"
          className={cn(
            'desktop-pet-body',
            mirrorsSprite(actor.facing, flipped) && 'is-left',
            actor.action === 'turn' && 'is-turning',
            actor.action === 'parachute' && 'is-chute',
            dragging && 'is-dragging',
          )}
          style={{ left: actor.x, top: actor.y, width: actor.box, height: actor.box }}
        >
          <div className={cn('pet-rig', actor.action === 'parachute' && 'is-chute')}>
            {chute ? <PetChute layer="back" depth={gear3d} {...chute} /> : null}
            <span className="desktop-pet-shadow" aria-hidden />
            <img
              ref={spriteRef}
              src={pet.src}
              alt={pet.name}
              draggable={false}
              style={{
                height: spriteH,
                ['--pet-gait' as string]: `${(0.78 / actionSpeeds.walk).toFixed(2)}s`,
                ['--pet-climb-gait' as string]: `${(0.92 / actionSpeeds.climb).toFixed(2)}s`,
                ['--pet-hang-gait' as string]: `${(1.15 / actionSpeeds.descend).toFixed(2)}s`,
              }}
              onLoad={(event) => measureSprite(event.currentTarget)}
              className={cn(
                'desktop-pet-sprite',
                !pet.animated &&
                  (actor.action === 'walk' || actor.action === 'walk-top') &&
                  'is-walk',
                !pet.animated && actor.action === 'idle' && 'is-idle',
                !pet.animated && actor.action === 'hop' && 'is-hop',
                !pet.animated && actor.action === 'climb' && 'is-climb',
                !pet.animated && actor.action === 'rappel' && 'is-hang',
                !pet.animated &&
                  (actor.action === 'rope-drop' || actor.action === 'throw') &&
                  'is-wait',
              )}
            />
            {chute ? <PetChute layer="front" depth={gear3d} {...chute} /> : null}
          </div>
        </div>
      ) : null}

      {bubble && speech ? (
        <div
          ref={speechElRef}
          className={cn(
            'pet-speech',
            bubbleBelow ? 'is-below' : 'is-above',
            speech.kind === 'fail' ? 'is-fail' : speech.kind === 'warn' ? 'is-warn' : 'is-pass',
          )}
          style={{ left: bubble.x, top: bubble.y, width: bubble.w }}
        >
          <p className="pet-speech-name">{speech.petName}</p>
          <p className="pet-speech-text">{speech.text}</p>
          {speech.run ? (
            <p className="pet-speech-link">
              <ExternalLink className="h-3 w-3" />
              <span>Click to open it in Runova</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {open && actor && placement && pet ? (
        <div
          ref={cardRef}
          className="absolute z-20"
          style={{ left: placement.left, top: placement.top }}
        >
          <PetStatsCard
            pet={pet}
            side={placement.side}
            view={cardView}
            onSelectView={handleSelectCardView}
            onClose={() => setOpen(false)}
          />
        </div>
      ) : null}

      {menu && pet ? (
        <div
          ref={menuElRef}
          className="absolute z-30"
          style={placePetMenu(
            menu.x,
            menu.y,
            areaRef.current.width,
            areaRef.current.height,
            menuSize.w,
            menuSize.h,
          )}
        >
          <PetMenu
            petName={pet.name}
            canMove={canMove}
            failedRun={Boolean(speech?.run)}
            onOpenApp={handleOpenApp}
            onToggleMove={handleToggleMove}
            onSnooze={handleSnooze}
            onTurnOff={handleTurnOff}
          />
        </div>
      ) : null}
    </div>
  );
}
