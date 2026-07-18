# Конфигурация

> Перевод. Источник истины — [English](../../user-guide/configuration.md). При расхождении верна английская версия.

Syncrypt синхронизирует то, что задано **профилем синхронизации** — небольшим YAML
с правилами `include` / `exclude`.

## Три категории данных

**1. Контент — всегда**

```
*.md
Attachments/
Canvas/       (*.canvas)
Excalidraw/
```

**2. Конфигурация — выборочно**

Полезно держать одинаковой на устройствах, но только выбранные файлы:

```
.obsidian/snippets/**
.obsidian/community-plugins.json
.obsidian/plugins/dataview/**
.obsidian/plugins/templater-obsidian/**
```

**3. Исключено — никогда**

Волатильное или специфичное для устройства:

```
.obsidian/cache/**
.obsidian/workspace.json
.obsidian/workspaces.json
.obsidian/app.json
.obsidian/sync-trash/**    # локальная корзина Safe Sync — не синкать
```

## Пример профиля

```yaml
# syncrypt.profile.yaml
version: 1
name: default
sync:
  include:
    - "**/*.md"
    - "Attachments/**"
    - "**/*.canvas"
    - ".obsidian/snippets/**"
    - ".obsidian/community-plugins.json"
  exclude:
    - ".obsidian/cache/**"
    - ".obsidian/workspace.json"
    - ".obsidian/sync-trash/**"
```

Правило: `exclude` важнее `include`. Пути сравниваются после нормализации Unicode
(нормализация Unicode-путей выполняется централизованно).

## Safe Mode и Safe Sync

Safe Mode **включён по умолчанию**: в сомнительной ситуации движок останавливается
и спрашивает, а не делает разрушительное действие. Он же включает защиту **Safe
Sync**:

- удаляемые файлы переносятся в локальную `.obsidian/sync-trash/` (не синкается), а
  не удаляются жёстко;
- удаления на стороне хранилища откладываются через tombstone с окном хранения;
- сохраняются несколько последних версий изменённых файлов;
- **предохранитель массовых изменений**: если синк затронет необычно много файлов
  (по умолчанию > 20 файлов или > 10% хранилища) — пауза и запрос подтверждения.
