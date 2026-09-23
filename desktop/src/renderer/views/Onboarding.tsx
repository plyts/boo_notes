import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { newCourse } from '../actions';
import { useApp } from '../store';
import { Button, Icon, Sheet, type IconName } from '../ui';

const STEPS: Array<{ icon: IconName; title: string; text: string; points: Array<[IconName, string]> }> = [
  {
    icon: 'ghost',
    title: 'Bienvenue dans Boo Notes',
    text: 'Votre second cerveau pour étudier : des notes reliées à tout ce que vous regardez, écoutez et lisez.',
    points: [
      ['video', 'Vidéos, audios, flux en direct, radios et podcasts'],
      ['file', 'PDF, images, textes et pages web'],
      ['clock', 'Des repères [04:15], [p. 12], [pin 3] qui y ramènent en un clic'],
    ],
  },
  {
    icon: 'course',
    title: 'Cours › chapitres › notes',
    text: 'Un cours se découpe en chapitres ; chaque chapitre rassemble des notes. Une note peut s’appuyer sur plusieurs supports à la fois.',
    points: [
      ['plus', 'Glissez vos fichiers dans la fenêtre : chacun reçoit sa note'],
      ['link', 'Tapez [[ pour relier une note à une autre'],
      ['mindmap', 'La carte mentale dessine tous ces liens'],
    ],
  },
  {
    icon: 'globe',
    title: 'Relier le navigateur',
    text: 'L’extension Boo Notes prend des notes sur n’importe quelle vidéo ou audio du web — YouTube, Udemy, Coursera, un podcast, une radio — et les range ici.',
    points: [
      ['settings', 'Dans l’extension : Réglages › App Desktop'],
      ['copy', 'Collez-y le jeton d’appairage ci-dessous'],
      ['check', 'Vos notes du navigateur rejoignent vos cours'],
    ],
  },
  {
    icon: 'cards',
    title: 'Réviser, exporter',
    text: 'Écrivez « Question :: Réponse » ou ==mot caché== dans vos notes : elles deviennent des cartes, révisées au bon rythme.',
    points: [
      ['export', 'Fiches de révision PDF, paquets Anki, données pour QCM'],
      ['notion', 'Tout se retrouve dans Notion, si vous le connectez'],
      ['sparkles', 'Tout reste en Markdown dans votre dossier de notes'],
    ],
  },
];

export function Onboarding() {
  const setSettings = useApp((s) => s.setSettings);
  const settings = useApp((s) => s.settings);
  const [step, setStep] = useState(0);
  const [open, setOpen] = useState(true);
  const finish = async (then?: () => void) => {
    setOpen(false);
    setSettings(await window.boo.settings.set({ onboarded: true }));
    then?.();
  };
  const s = STEPS[step];
  const last = step === STEPS.length - 1;
  return (
    <Sheet isOpen={open} onOpenChange={(o) => !o && void finish()} label="Découvrir Boo Notes">
      <div className="onboarding">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={step} className="onboarding-step" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
            <span className="onboarding-icon">
              <Icon name={s.icon} size={34} />
            </span>
            <h2>{s.title}</h2>
            <p>{s.text}</p>
            {s.icon === 'globe' && settings ? (
              <div className="onboarding-token">
                <code className="token">{settings.token}</code>
                <Button size="s" icon="copy" onPress={() => void window.boo.settings.copy(settings.token)}>
                  Copier
                </Button>
                <small>
                  Adresse : <code>ws://localhost:{settings.port}</code>
                </small>
              </div>
            ) : null}
            <ul>
              {s.points.map(([icon, text]) => (
                <li key={text}>
                  <Icon name={icon} size={16} />
                  {text}
                </li>
              ))}
            </ul>
          </motion.div>
        </AnimatePresence>
        <div className="onboarding-dots" aria-hidden="true">
          {STEPS.map((_, i) => (
            <span key={i} className={i === step ? 'on' : ''} />
          ))}
        </div>
        <div className="sheet-actions">
          {step > 0 ? (
            <Button variant="plain" onPress={() => setStep(step - 1)}>
              Précédent
            </Button>
          ) : (
            <Button variant="plain" onPress={() => void finish()}>
              Passer
            </Button>
          )}
          {last ? (
            <Button variant="primary" icon="course" onPress={() => void finish(() => void newCourse())}>
              Créer mon premier cours
            </Button>
          ) : (
            <Button variant="primary" onPress={() => setStep(step + 1)}>
              Continuer
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
