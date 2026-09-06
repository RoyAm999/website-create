(() => {
  const body = document.body;
  const motionToggle = document.getElementById('motionToggle');
  const hero = document.querySelector('.hero');
  const heroEarth = document.querySelector('.hero-earth');
  const astronaut = document.querySelector('.astronaut');
  const heroCopy = document.querySelector('.hero-copy');
  const earthDive = document.querySelector('.earth-dive');
  const earthDiveImg = document.querySelector('.earth-dive-img');
  const diveCopy = document.querySelector('.dive-copy');
  const topbar = document.getElementById('topbar');
  const starA = document.querySelector('.starfield-a');
  const starB = document.querySelector('.starfield-b');
  const cursor = document.querySelector('.cursor-orbit');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let manualMotionOff = reduceMotion.matches;
  let ticking = false;

  const clamp = (n, min = 0, max = 1) => Math.min(max, Math.max(min, n));
  const progressOf = (el) => {
    const rect = el.getBoundingClientRect();
    const travel = Math.max(1, el.offsetHeight - innerHeight);
    return clamp(-rect.top / travel);
  };

  function updateMotionLabel() {
    motionToggle.setAttribute('aria-pressed', String(manualMotionOff));
    motionToggle.textContent = manualMotionOff ? 'תנועה: כבויה' : 'תנועה: פועלת';
    body.classList.toggle('motion-off', manualMotionOff);
  }

  function render() {
    ticking = false;
    topbar.classList.toggle('scrolled', scrollY > 30);
    if (manualMotionOff) return;

    const mobile = innerWidth <= 900;
    const hp = progressOf(hero);
    const ease = hp * hp * (3 - 2 * hp);
    const earthScale = mobile ? 1 + ease * .18 : 1 + ease * .28;
    const earthY = ease * (mobile ? -45 : -100);
    heroEarth.style.transform = `translate3d(0,${earthY}px,0) scale(${earthScale})`;

    const baseX = mobile ? -50 : -38;
    const baseY = mobile ? -50 : -47;
    const x = baseX + ease * (mobile ? 5 : 10);
    const y = baseY - ease * (mobile ? 7 : 9);
    const scale = 1 + ease * (mobile ? .12 : .2);
    const rot = -8 + ease * 6;
    astronaut.style.transform = `translate(${x}%,${y}%) rotate(${rot}deg) scale(${scale})`;
    heroCopy.style.opacity = String(1 - clamp((hp - .54) / .36));
    heroCopy.style.transform = `translate3d(0,${-ease * 55}px,0)`;
    starA.style.transform = `translate3d(${ease * -15}px,${ease * -38}px,0)`;
    starB.style.transform = `translate3d(${ease * 22}px,${ease * -70}px,0)`;

    const dp = progressOf(earthDive);
    const dEase = dp * dp * (3 - 2 * dp);
    const dScale = (mobile ? .52 : .66) + dEase * (mobile ? .62 : .7);
    const dY = mobile ? -45 + dEase * 8 : -50 + dEase * 8;
    earthDiveImg.style.transform = `translate(-50%,${dY}%) scale(${dScale})`;
    diveCopy.style.opacity = String(1 - clamp((dp - .55) / .28));
    diveCopy.style.transform = `translate3d(0,${-dEase * 36}px,0)`;
  }

  function scheduleRender() {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(render);
    }
  }

  motionToggle.addEventListener('click', () => {
    manualMotionOff = !manualMotionOff;
    updateMotionLabel();
    render();
  });
  reduceMotion.addEventListener?.('change', e => {
    manualMotionOff = e.matches;
    updateMotionLabel();
    render();
  });

  window.addEventListener('scroll', scheduleRender, { passive:true });
  window.addEventListener('resize', scheduleRender, { passive:true });

  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const target = document.querySelector(a.getAttribute('href'));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: manualMotionOff ? 'auto' : 'smooth', block:'start' });
    });
  });

  const readout = document.getElementById('hotspotReadout');
  document.querySelectorAll('.hotspot').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.hotspot').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      readout.querySelector('.readout-number').textContent = btn.dataset.index;
      readout.querySelector('strong').textContent = btn.dataset.title;
      readout.querySelector('p').textContent = btn.dataset.copy;
    });
  });

  const destData = {
    earth: { title:'כדור הארץ', counter:'01 / 03', text:'המקום שממנו כל מסע מתחיל — והדבר הראשון שנראה אחרת ברגע שמתרחקים ממנו.' },
    moon: { title:'הירח', counter:'02 / 03', text:'אופק ללא אוויר, מרחק ללא ערפל. עולם שבו האור חד והצל כמעט מוחלט.' },
    mars: { title:'מאדים', counter:'03 / 03', text:'מדבר עצום, קפוא ודק־אוויר — יעד שמרגיש כמו הגבול הבא של נוכחות אנושית.' }
  };
  const stage = document.querySelector('.destination-stage');
  const title = stage.querySelector('h2');
  const counter = stage.querySelector('.dest-counter');
  const text = stage.querySelector('.destination-text');
  document.querySelectorAll('.dest-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const dest = btn.dataset.dest;
      stage.dataset.destination = dest;
      document.querySelectorAll('.dest-tab').forEach(b => { b.classList.toggle('active', b === btn); b.setAttribute('aria-selected', String(b === btn)); });
      document.querySelectorAll('.destination-image').forEach(img => img.classList.toggle('active', img.classList.contains(`dest-${dest}`)));
      title.textContent = destData[dest].title;
      counter.textContent = destData[dest].counter;
      text.textContent = destData[dest].text;
    });
  });

  if (matchMedia('(pointer:fine)').matches) {
    window.addEventListener('pointermove', e => {
      cursor.style.left = `${e.clientX}px`;
      cursor.style.top = `${e.clientY}px`;
    }, {passive:true});
    document.querySelectorAll('a,button').forEach(el => {
      el.addEventListener('pointerenter', () => { cursor.style.width='58px'; cursor.style.height='58px'; });
      el.addEventListener('pointerleave', () => { cursor.style.width='40px'; cursor.style.height='40px'; });
    });
  }

  updateMotionLabel();
  render();
})();