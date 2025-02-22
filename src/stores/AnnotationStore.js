import { destroy, detach, getEnv, getParent, getRoot, isAlive, onSnapshot, types } from "mobx-state-tree";

import Constants from "../core/Constants";
import { Hotkey } from "../core/Hotkey";
import RegionStore from "./RegionStore";
import Registry from "../core/Registry";
import RelationStore from "./RelationStore";
import TimeTraveller from "../core/TimeTraveller";
import Tree, { TRAVERSE_STOP } from "../core/Tree";
import Types from "../core/Types";
import Utils from "../utils";
import { delay, isDefined } from "../utils/utilities";
import { guidGenerator } from "../core/Helpers";
import { DataValidator, ValidationError, VALIDATORS } from "../core/DataValidator";
import { errorBuilder } from "../core/DataValidator/ConfigValidator";
import Area from "../regions/Area";
import throttle from "lodash.throttle";
import { ViewModel } from "../tags/visual";
import { UserExtended } from "./UserStore";
import { FF_DEV_1555, FF_DEV_1621, isFF } from "../utils/feature-flags";

const hotkeys = Hotkey("Annotations", "Annotations");

const Annotation = types
  .model("Annotation", {
    id: types.identifier,
    // @todo this value used `guidGenerator(5)` as default value before
    // @todo but it calculates once, so all the annotations have the same pk
    // @todo why don't use only `id`?
    // @todo reverted back to wrong type; maybe it breaks all the deserialisation
    pk: types.maybeNull(types.string),

    selected: types.optional(types.boolean, false),
    type: types.enumeration(["annotation", "prediction", "history"]),
    acceptedState: types.optional(
      types.maybeNull(
        types.enumeration(['fixed', 'accepted', 'rejected']),
      ), null,
    ),

    createdDate: types.optional(types.string, Utils.UDate.currentISODate()),
    createdAgo: types.maybeNull(types.string),
    createdBy: types.optional(types.string, "Admin"),
    user: types.optional(types.maybeNull(types.safeReference(UserExtended)), null),

    parent_prediction: types.maybeNull(types.integer),
    parent_annotation: types.maybeNull(types.integer),
    last_annotation_history: types.maybeNull(types.integer),

    loadedDate: types.optional(types.Date, new Date()),
    leadTime: types.maybeNull(types.number),

    // @todo use types.Date
    draftSaved: types.maybe(types.string),

    // created by user during this session
    userGenerate: types.optional(types.boolean, true),
    update: types.optional(types.boolean, false),
    sentUserGenerate: types.optional(types.boolean, false),
    localUpdate: types.optional(types.boolean, false),

    ground_truth: types.optional(types.boolean, false),
    skipped: false,

    history: types.optional(TimeTraveller, { targetPath: "../areas" }),

    dragMode: types.optional(types.boolean, false),

    editable: types.optional(types.boolean, true),

    relationMode: types.optional(types.boolean, false),
    relationStore: types.optional(RelationStore, {
      relations: [],
    }),

    areas: types.map(Area),

    suggestions: types.map(Area),

    regionStore: types.optional(RegionStore, {
      regions: [],
    }),

  })
  .preProcessSnapshot(sn => {
    // sn.draft = Boolean(sn.draft);
    let user = sn.user ?? sn.completed_by ?? undefined;

    if (user && typeof user !== 'number') {
      user = user.id;
    }

    return {
      ...sn,
      user,
      ground_truth: sn.honeypot ?? sn.ground_truth ?? false,
      skipped: sn.skipped || sn.was_cancelled,
      acceptedState: sn.accepted_state ?? sn.acceptedState ?? null,
    };
  })
  .views(self => ({
    get store() {
      return getRoot(self);
    },

    get list() {
      return getParent(self, 2);
    },

    get root() {
      return self.list.root;
    },

    get names() {
      return self.list.names;
    },

    get toNames() {
      return self.list.toNames;
    },

    get objects() {
      return Array.from(self.names.values()).filter(tag => !tag.toname);
    },

    get regions() {
      return Array.from(self.areas.values());
    },

    get results() {
      const results = [];

      self.areas.forEach(a => a.results.forEach(r => results.push(r)));
      return results;
    },

    get serialized() {
      // Dirty hack to force MST track changes
      self.areas.toJSON();

      return self.results
        .map(r => r.serialize())
        .filter(Boolean)
        .concat(self.relationStore.serializeAnnotation());
    },

    get serializedSelection() {
      // Dirty hack to force MST track changes
      self.areas.toJSON();

      const selectedResults = [];

      self.areas.forEach(a => {
        if (!a.inSelection) return;
        a.results.forEach(r => {
          selectedResults.push(r);
        });
      });

      return selectedResults
        .map(r => r.serialize())
        .filter(Boolean);
    },

    get highlightedNode() {
      return self.regionStore.selection.highlighted;
    },

    get hasSelection() {
      return self.regionStore.selection.hasSelection;
    },
    get selectionSize() {
      return self.regionStore.selection.size;
    },

    get selectedRegions() {
      return Array.from(self.regionStore.selection.selected.values());
    },

    // existing annotation which can be updated
    get exists() {
      const dataExists = (self.userGenerate && self.sentUserGenerate) || isDefined(self.versions.result);
      const pkExists = isDefined(self.pk);

      return dataExists && pkExists;
    },

    get onlyTextObjects() {
      return self.objects.reduce((res, obj) => {
        return res && ['text', 'hypertext'].includes(obj.type);
      }, true);
    },
  }))
  .volatile(() => ({
    hidden: false,
    draftId: 0,
    draftSelected: false,
    autosaveDelay: 5000,
    isDraftSaving: false,
    versions: {},
    resultSnapshot: "",
  }))
  .actions(self => ({
    reinitHistory() {
      self.history.reinit();
      self.autosave && self.autosave.cancel();
      if (self.type === "annotation") self.setInitialValues();
    },

    setEdit(val) {
      self.editable = val;
    },

    setGroundTruth(value, ivokeEvent = true) {
      const root = getRoot(self);

      if (root && root !== self && ivokeEvent) {
        const as = root.annotationStore;
        const assignGroundTruths = p => {
          if (self !== p) p.setGroundTruth(false, false);
        };

        as.predictions.forEach(assignGroundTruths);
        as.annotations.forEach(assignGroundTruths);
      }

      self.ground_truth = value;

      if (ivokeEvent) {
        getEnv(self).events.invoke('groundTruth', self.store, self, value);
      }
    },

    sendUserGenerate() {
      self.sentUserGenerate = true;
    },

    setLocalUpdate(value) {
      self.localUpdate = value;
    },

    setDragMode(val) {
      self.dragMode = val;
    },

    updatePersonalKey(value) {
      self.pk = value;
      getRoot(self).addAnnotationToTaskHistory(self.pk);
    },

    toggleVisibility(visible) {
      self.hidden = visible === undefined ? !self.hidden : !visible;
    },

    setHighlightedNode() {
      // moved to selectArea and others
    },

    selectArea(area) {
      if (self.highlightedNode === area) return;
      // if (current) current.setSelected(false);
      self.regionStore.highlight(area);
      // area.setSelected(true);
    },

    toggleRegionSelection(area, isSelected) {
      self.regionStore.toggleSelection(area, isSelected);
    },

    selectAreas(areas) {
      self.unselectAreas();
      self.extendSelectionWith(areas);
    },

    extendSelectionWith(areas) {
      for (const area of (Array.isArray(areas) ? areas : [areas])) {
        self.regionStore.toggleSelection(area, true);
      }
    },

    unselectArea(area) {
      if (self.highlightedNode !== area) return;
      // area.setSelected(false);
      self.regionStore.toggleSelection(area, false);
    },

    unselectAreas() {
      if (!self.selectionSize) return;
      self.regionStore.clearSelection();
    },

    deleteSelectedRegions() {
      self.selectedRegions.forEach(region => {
        region.deleteRegion();
      });
    },

    unselectStates() {
      self.names.forEach(tag => tag.unselectAll && tag.unselectAll());
    },

    /**
     * @param {boolean} tryToKeepStates don't unselect labels if such setting is enabled
     */
    unselectAll(tryToKeepStates = false) {
      const keepStates = tryToKeepStates && self.store.settings.continuousLabeling;

      self.unselectAreas();
      if (!keepStates) self.unselectStates();
    },

    removeArea(area) {
      destroy(area);
    },

    startRelationMode(node1) {
      self._relationObj = node1;
      self.relationMode = true;

      document.body.style.cursor = Constants.CHOOSE_CURSOR;
    },

    stopRelationMode() {
      document.body.style.cursor = Constants.DEFAULT_CURSOR;

      self._relationObj = null;
      self.relationMode = false;

      self.regionStore.unhighlightAll();
    },

    deleteAllRegions({ deleteReadOnly = false } = {}) {
      let regions = Array.from(self.areas.values());

      // @todo classifiactions have `readonly===undefined` so they won't be deleted with `false`
      // @todo check this later for consistency
      if (deleteReadOnly === false) regions = regions.filter(r => r.readonly === false);

      regions.forEach(r => r.deleteRegion());
      self.updateObjects();
    },

    addRegion(reg) {
      self.regionStore.unselectAll(true);

      if (self.relationMode) {
        self.addRelation(reg);
        self.stopRelationMode();
      }
    },

    loadRegionState(region) {
      region.states &&
        region.states.forEach(s => {
          const mainViewTag = self.names.get(s.name);

          mainViewTag.unselectAll && mainViewTag.unselectAll();
          mainViewTag.copyState(s);
        });
    },

    unloadRegionState(region) {
      region.states &&
        region.states.forEach(s => {
          const mainViewTag = self.names.get(s.name);

          mainViewTag.unselectAll && mainViewTag.unselectAll();
          mainViewTag.perRegionCleanup && mainViewTag.perRegionCleanup();
        });
    },

    addRelation(reg) {
      self.relationStore.addRelation(self._relationObj, reg);
    },

    validate() {
      let ok = true;

      self.traverseTree(function(node) {
        if (node.required === true) {
          ok = node.validate();
          if (ok === false) {
            ok = false;
            return TRAVERSE_STOP;
          }
        }
      });

      return ok;
    },

    traverseTree(cb) {
      return Tree.traverseTree(self.root, cb);
    },

    /**
     *
     */
    beforeSend() {
      self.traverseTree(node => {
        if (node && node.beforeSend) {
          node.beforeSend();
        }
      });

      self.stopRelationMode();
      self.unselectAll();
    },

    /**
     * Delete region
     * @param {*} region
     */
    deleteRegion(region) {
      const { regions } = self.regionStore;
      // move all children into the parent region of the given one
      const children = regions.filter(r => r.parentID === region.id);

      children && children.forEach(r => r.setParentID(region.parentID));

      if (!region.classification) getEnv(self).events.invoke('entityDelete', region);

      self.relationStore.deleteNodeRelation(region);
      if (region.type === "polygonregion") {
        detach(region);
      }

      destroy(region);
    },

    deleteArea(area) {
      destroy(area);
    },

    undo() {
      const { history, regionStore } = self;

      if (history && history.canUndo) {
        const selectedIds = regionStore.selectedIds;

        history.undo();
        regionStore.selectRegionsByIds(selectedIds);
      }
    },

    redo() {
      const { history, regionStore } = self;

      if (history && history.canRedo) {
        const selectedIds = regionStore.selectedIds;

        history.redo();
        regionStore.selectRegionsByIds(selectedIds);
      }
    },

    // update some fragile parts after snapshot manipulations (undo/redo)
    updateObjects() {
      self.unselectAll();
      self.names.forEach(tag => tag.needsUpdate && tag.needsUpdate());
      self.areas.forEach(area => area.updateAppearenceFromState && area.updateAppearenceFromState());
    },

    setInitialValues() {
      // <Label selected="true"/>
      self.names.forEach(tag => {
        if (tag.type.endsWith("labels")) {
          // @todo check for choice="multiple" and multiple preselected labels
          const preselected = tag.children?.find(label => label.initiallySelected);

          if (preselected) preselected.setSelected(true);
        }
      });

      // @todo deal with `defaultValue`s
    },

    addVersions(versions) {
      self.versions = { ...self.versions, ...versions };
      if (versions.draft) self.setDraftSelected();
    },

    toggleDraft() {
      const isDraft = self.draftSelected;

      if (!isDraft && !self.versions.draft) return;
      self.autosave.flush();
      self.pauseAutosave();
      if (isDraft) self.versions.draft = self.serializeAnnotation({ fast: true });
      self.deleteAllRegions({ deleteReadOnly: true });
      if (isDraft) {
        self.deserializeResults(self.versions.result);
        self.draftSelected = false;
      } else {
        self.deserializeResults(self.versions.draft);
        self.draftSelected = true;
      }
      self.updateObjects();
      self.startAutosave();
    },

    async startAutosave() {
      if (!getEnv(self).events.hasEvent('submitDraft')) return;
      if (self.type !== "annotation") return;

      // some async tasks should be performed after deserialization
      // so start autosave on next tick
      await delay(0);

      if (self.autosave) {
        self.autosave.cancel();
        self.autosave.paused = false;
        return;
      }

      // mobx will modify methods, so add it directly to have cancel() method
      self.autosave = throttle(
        () => {
          if (self.autosave.paused) return;

          const result = self.serializeAnnotation({ fast: true });
          // if this is new annotation and no regions added yet

          if (!self.pk && !result.length) return;

          self.setDraftSelected();
          self.versions.draft = result;

          self.store.submitDraft(self).then(self.onDraftSaved);
        },
        self.autosaveDelay,
        { leading: false },
      );

      onSnapshot(self.areas, self.autosave);
    },

    pauseAutosave() {
      if (!self.autosave) return;
      self.autosave.paused = true;
      self.autosave.cancel();
    },

    beforeDestroy() {
      self.autosave && self.autosave.cancel && self.autosave.cancel();
    },

    setDraftId(id) {
      self.draftId = id;
    },

    setDraftSelected(selected = true) {
      self.draftSelected = selected;
    },

    onDraftSaved() {
      self.draftSaved = Utils.UDate.currentISODate();
    },

    dropDraft() {
      if (!self.autosave) return;
      self.autosave.cancel();
      self.draftId = 0;
      self.draftSelected = false;
      self.draftSaved = undefined;
      self.versions.draft = undefined;
    },

    afterAttach() {
      self.traverseTree(node => {
        // called when the annotation is attached to the main store,
        // at this point the whole tree is available. This method
        // may come handy when you have a tag that acts or depends
        // on other elements in the tree.
        if (node.annotationAttached) node.annotationAttached();

        // copy tools from control tags into object tools manager
        // [DOCS] each object tag may have an assigned tools
        // manager. This assignment may happen because user asked
        // for it through the config, or because the attached
        // control tags are complex and require additional UI
        // interfaces. Each control tag defines a set of tools it
        // supports
        if (node && node.getToolsManager) {
          const tools = node.getToolsManager();
          const states = self.toNames.get(node.name);

          states && states.forEach(s => tools.addToolsFromControl(s));
        }

        // @todo special place to init such predefined values; `afterAttach` of the tag?
        // preselected choices
        if (!self.pk && node?.type === "choices" && node.preselectedValues?.length) {
          self.createResult({}, { choices: node.preselectedValues }, node, node.toname);
        }
      });

      self.history.onUpdate(self.updateObjects);
      self.startAutosave();
    },

    afterCreate() {
      if (self.userGenerate && !self.sentUserGenerate) {
        self.loadedDate = new Date();
      }
    },

    setupHotKeys() {
      hotkeys.unbindAll();

      let audiosNum = 0;
      let audioNode = null;
      const mod = "shift+space";
      let comb = mod;

      // [TODO] we need to traverse this two times, fix
      // Hotkeys setup
      self.traverseTree(node => {
        if (node && node.onHotKey && node.hotkey) {
          hotkeys.addKey(node.hotkey, node.onHotKey, undefined, node.hotkeyScope);
        }
      });

      self.traverseTree(node => {
        // add Space hotkey for playbacks of audio, there might be
        // multiple audios on the screen
        if (node && !node.hotkey && (node.type === "audio" || node.type === "audioplus")) {
          if (audiosNum > 0) comb = mod + "+" + (audiosNum + 1);
          else audioNode = node;

          node.hotkey = comb;
          hotkeys.addKey(comb, node.onHotKey, "Play an audio", Hotkey.DEFAULT_SCOPE + "," + Hotkey.INPUT_SCOPE);

          audiosNum++;
        }
      });

      self.traverseTree(node => {
        /**
         * Hotkey for controls
         */
        if (node && node.onHotKey && !node.hotkey) {
          const comb = hotkeys.makeComb();

          if (!comb) return;

          node.hotkey = comb;
          hotkeys.addKey(node.hotkey, node.onHotKey);
        }
      });

      if (audioNode && audiosNum > 1) {
        audioNode.hotkey = mod + "+1";
        hotkeys.addKey(audioNode.hotkey, audioNode.onHotKey);
        hotkeys.removeKey(mod);
      }

      // prevent spacebar from scrolling
      // document.onkeypress = function(e) {
      //     e = e || window.event;

      //   var charCode = e.keyCode || e.which;
      //   if (charCode === 32) {
      //     e.preventDefault();
      //     return false;
      //   }
      // };

      Hotkey.setScope(Hotkey.DEFAULT_SCOPE);
    },

    createResult(areaValue, resultValue, control, object) {
      const result = {
        from_name: control.name,
        // @todo should stick to area
        to_name: object,
        type: control.resultType,
        value: resultValue,
      };

      const areaRaw = {
        id: guidGenerator(),
        object,
        // data for Model instance
        ...areaValue,
        // for Model detection
        value: areaValue,
        results: [result],
      };

      const area = self.areas.put(areaRaw);

      if (!area.classification) getEnv(self).events.invoke('entityCreate', area);

      if (self.store.settings.selectAfterCreate) {
        if (!area.classification) {
          // some regions might need some actions right after creation (i.e. text)
          // and some may be already deleted (i.e. bboxes)
          setTimeout(() => isAlive(area) && self.selectArea(area));
        }
      } else {
        // unselect labels after use, but consider "keep labels selected" settings
        if (control.type.includes("labels")) self.unselectAll(true);
      }

      return area;
    },

    appendResults(results) {
      const regionIdMap = {};
      const prevSize = self.regionStore.regions.length;

      // Generate new ids to prevent collisions
      results.forEach((result)=>{
        const regionId = result.id;

        if (!regionIdMap[regionId]) {
          regionIdMap[regionId] = guidGenerator();
        }
        result.id = regionIdMap[regionId];
      });

      self.deserializeResults(results);
      self.updateObjects();
      return self.regionStore.regions.slice(prevSize);
    },

    serializeAnnotation(options) {
      // return self.serialized;

      document.body.style.cursor = "wait";

      const result = self.results
        .map(r => r.serialize(options))
        .filter(Boolean)
        .concat(self.relationStore.serializeAnnotation(options));

      document.body.style.cursor = "default";

      return result;
    },

    // Some annotations may be created with wrong assumptions
    // And this problems are fixable, so better to fix them on start
    fixBrokenAnnotation(json) {
      return (json ?? []).reduce((res, objRaw) => {
        const obj = JSON.parse(JSON.stringify(objRaw));

        if (obj.type === 'relation') {
          res.push(objRaw);
          return res;
        }

        if (obj.type === "htmllabels") obj.type = "hypertextlabels";
        if (obj.normalization) obj.meta = { ...obj.meta, text: [obj.normalization] };
        const tagNames = self.names;

        // Clear non-existent labels
        if (obj.type.endsWith("labels")) {
          const keys = Object.keys(obj.value);

          for (let key of keys) {
            if (key.endsWith("labels")) {
              const hasControlTag = tagNames.has(obj.from_name) || tagNames.has("labels");

              if (hasControlTag) {
                const labelsContainer = tagNames.get(obj.from_name) ?? tagNames.get("labels");
                const value = obj.value[key];

                if (value && value.length && labelsContainer.type.endsWith("labels")) {
                  const filteredValue = value.filter(labelName => !!labelsContainer.findLabel(labelName));
                  const oldKey = key;

                  key = key === labelsContainer.type ? key : labelsContainer.type;

                  if (oldKey !== key) {
                    obj.type = key;
                    obj.value[key] = obj.value[oldKey];
                    delete obj.value[oldKey];
                  }

                  if (filteredValue.length !== value.length) {
                    obj.value[key] = filteredValue;
                  }
                }
              }

              if (
                !tagNames.has(obj.from_name) ||
                (!obj.value[key].length && !tagNames.get(obj.from_name).allowempty)
              ) {
                delete obj.value[key];
                if (tagNames.has(obj.to_name)) {
                  // Redirect references to existent tool
                  const targetObject = tagNames.get(obj.to_name);
                  const states = targetObject.states();

                  if (states?.length) {
                    const altToolsControllerType = obj.type.replace(/labels$/, "");
                    const sameLabelsType = obj.type;
                    const simpleLabelsType = "labels";

                    for (const altType of [altToolsControllerType, sameLabelsType, simpleLabelsType]) {
                      const state = states.find(state => state.type === altType);

                      if (state) {
                        obj.type = altType;
                        obj.from_name = state.name;
                        break;
                      }
                    }
                  }
                }
              }
            }
          }
        }

        if (tagNames.has(obj.from_name) && tagNames.has(obj.to_name)) {
          res.push(obj);
        }

        return res;
      }, []);
    },

    setSuggestions(rawSuggestions) {
      self.suggestions.clear();

      self.deserializeResults(rawSuggestions, {
        suggestions: true,
      });

      if (getRoot(self).autoAcceptSuggestions) {
        self.acceptAllSuggestions();
      } else {
        self.suggestions.forEach((suggestion) => {
          if (['richtextregion', 'text'].includes(suggestion.type)) {
            self.acceptSuggestion(suggestion.id);
          }
        });
      }

      if (isFF(FF_DEV_1555)) {
        self.updateObjects();
      } else {
        self.objects.forEach(obj => obj.needsUpdate?.());
      }
    },

    /**
     * Deserialize results
     * @param {string | Array<any>} json Input results
     * @param {{
     * suggestions: boolean
     * }} options Deserialization options
     */
    deserializeResults(json, { suggestions = false, hidden = false } = {}) {
      try {
        const objAnnotation = self.prepareAnnotation(json);
        const areas = suggestions ? self.suggestions : self.areas;

        self._initialAnnotationObj = objAnnotation;

        objAnnotation.forEach(obj => {
          self.deserializeSingleResult(obj,
            (id) => areas.get(id),
            (snapshot) => areas.put(snapshot),
          );
        });

        !hidden && self.results
          .filter(r => r.area.classification)
          .forEach(r => r.from_name.updateFromResult?.(r.mainValue));

        objAnnotation.forEach(obj => {
          if (obj["type"] === "relation") {
            self.relationStore.deserializeRelation(
              `${obj.from_id}#${self.id}`,
              `${obj.to_id}#${self.id}`,
              obj.direction,
              obj.labels,
            );
          }
        });
      } catch (e) {
        console.error(e);
        self.list.addErrors([errorBuilder.generalError(e)]);
      }
    },

    deserializeAnnotation(...args) {
      console.warn('deserializeAnnotation() is deprecated. Use deserializeResults() instead');
      return self.deserializeResults(...args);
    },

    prepareAnnotation(rawAnnotation) {
      let objAnnotation = rawAnnotation;

      if (typeof objAnnotation !== "object") {
        objAnnotation = JSON.parse(objAnnotation);
      }

      objAnnotation = self.fixBrokenAnnotation(objAnnotation ?? []);

      return objAnnotation;
    },

    deserializeSingleResult(obj, getArea, createArea) {
      if (obj["type"] !== "relation") {
        const { id, value: rawValue, type, ...data } = obj;

        const object = self.names.get(obj.to_name) ?? {};
        const tagType = object.type;

        // avoid duplicates of the same areas in different annotations/predictions
        const areaId = `${id || guidGenerator()}#${self.id}`;
        const resultId = `${data.from_name}@${areaId}`;
        const value = self.prepareValue(rawValue, tagType);

        let area = getArea(areaId);

        if (!area) {
          const areaSnapshot = {
            id: areaId,
            object: data.to_name,
            ...data,
            ...value,
            value,
          };

          area = createArea(areaSnapshot);
        }

        area.addResult({ ...data, id: resultId, type, value });

        // if there is merged result with region data and type and also with the labels
        // and object allows such merge — create new result with these labels
        if (!type.endsWith("labels") && value.labels && object.mergeLabelsAndResults) {
          const labels = value.labels;
          const labelControl = object.states()?.find(control => control?.findLabel(labels[0]));

          area.setValue(labelControl);
          area.results.find(r => r.type.endsWith("labels"))?.setValue(labels);
        }
      }
    },

    prepareValue(value, type) {
      switch (type) {
        case "text":
        case "hypertext":
        case "richtext": {
          const hasStartEnd = isDefined(value.start) && isDefined(value.end);
          const lacksOffsets = !isDefined(value.startOffset) && !isDefined(value.endOffset);

          if (hasStartEnd && lacksOffsets) {
            return Object.assign({}, value, {
              start: "",
              end: "",
              startOffset: Number(value.start),
              endOffset: Number(value.end),
              isText: true,
            });
          }
          break;
        }
        default:
          return value;
      }

      return value;
    },

    acceptAllSuggestions() {
      Array.from(self.suggestions.keys()).forEach((id) => {
        self.acceptSuggestion(id);
      });
      self.deleteAllDynamicregions();
    },

    rejectAllSuggestions() {
      Array.from(self.suggestions.keys).forEach((id) => {
        self.suggestions.delete(id);
      });
      self.deleteAllDynamicregions();
    },

    deleteAllDynamicregions() {
      self.regions.forEach(r => {
        r.dynamic && r.deleteRegion();
      });
    },

    acceptSuggestion(id) {
      const item = self.suggestions.get(id);

      self.areas.set(id, {
        ...item.toJSON(),
        fromSuggestion: true,
      });
      const area = self.areas.get(id);
      const activeStates = area.object.activeStates();

      activeStates.forEach(state => {
        area.setValue(state);
      });
      self.suggestions.delete(id);
    },

    rejectSuggestion(id) {
      self.suggestions.delete(id);
    },

    resetReady() {
      self.objects.forEach(object => object.setReady && object.setReady(false));
      self.areas.forEach(area => area.setReady && area.setReady(false));
    },
  }));

export default types
  .model("AnnotationStore", {
    selected: types.maybeNull(types.reference(Annotation)),
    selectedHistory: types.maybeNull(types.safeReference(Annotation)),

    root: Types.allModelsTypes(),
    names: types.map(types.reference(Types.allModelsTypes())),
    toNames: types.map(types.array(types.reference(Types.allModelsTypes()))),

    annotations: types.array(Annotation),
    predictions: types.array(Annotation),
    history: types.array(Annotation),

    viewingAllAnnotations: types.optional(types.boolean, false),
    viewingAllPredictions: types.optional(types.boolean, false),

    validation: types.maybeNull(types.array(ValidationError)),
  })
  .views(self => ({
    get store() {
      return getRoot(self);
    },

    get viewingAll() {
      return self.viewingAllAnnotations || self.viewingAllPredictions;
    },
  }))
  .actions(self => {
    function toggleViewingAll() {
      if (self.viewingAllAnnotations || self.viewingAllPredictions) {
        if (self.selected) {
          self.selected.unselectAll();
          self.selected.selected = false;
        }

        self.annotations.forEach(c => {
          c.editable = false;
        });
      } else {
        selectAnnotation(self.annotations[0].id);
      }
    }

    function toggleViewingAllPredictions() {
      self.viewingAllPredictions = !self.viewingAllPredictions;

      if (self.viewingAllPredictions) self.viewingAllAnnotations = false;

      toggleViewingAll();
    }

    function toggleViewingAllAnnotations() {
      self.viewingAllAnnotations = !self.viewingAllAnnotations;

      if (self.viewingAllAnnotations) self.viewingAllPredictions = false;

      toggleViewingAll();
    }

    function unselectViewingAll() {
      self.viewingAllAnnotations = false;
      self.viewingAllPredictions = false;
    }

    function _unselectAll() {
      if (self.selected) {
        self.selected.unselectAll();
        self.selected.selected = false;
      }
    }

    function _selectItem(item) {
      self._unselectAll();
      item.editable = false;
      item.selected = true;
      self.selected = item;
      item.updateObjects();
    }

    function selectItem(id, list) {
      unselectViewingAll();

      self._unselectAll();

      // sad hack with pk while sdk are not using pk everywhere
      const c = list.find(c => c.id === id || c.pk === String(id)) || list[0];

      if (!c) return null;
      c.selected = true;
      self.selected = c;
      c.updateObjects();
      if (c.type === "annotation") c.setInitialValues();

      return c;
    }

    /**
     * Select annotation
     * @param {*} id
     */
    function selectAnnotation(id) {
      if (!self.annotations.length) return null;

      const { selected } = self;
      const c = selectItem(id, self.annotations);

      c.editable = true;
      c.setupHotKeys();

      getEnv(self).events.invoke('selectAnnotation', c, selected);
      if (c.pk) getParent(self).addAnnotationToTaskHistory(c.pk);
      return c;
    }

    function selectPrediction(id) {
      const p = selectItem(id, self.predictions);

      return p;
    }

    function deleteAnnotation(annotation) {
      getEnv(self).events.invoke('deleteAnnotation', self.store, annotation);

      /**
       * MST destroy annotation
       */
      destroy(annotation);

      self.selected = null;
      /**
       * Select other annotation
       */
      if (self.annotations.length > 0) {
        self.selectAnnotation(self.annotations[0].id);
      }
    }

    function showError(err) {
      if (err) self.addErrors([errorBuilder.generalError(err)]);
      // we have to return at least empty View to display interface
      return (self.root = ViewModel.create({ id: "error" }));
    }

    function initRoot(config) {
      if (self.root) return;

      if (!config) {
        return (self.root = ViewModel.create({ id:"empty" }));
      }

      // convert config to mst model
      let rootModel;

      try {
        rootModel = Tree.treeToModel(config, self.store);
      } catch (e) {
        console.error(e);
        return showError(e);
      }
      const modelClass = Registry.getModelByTag(rootModel.type);
      // hacky way to get all the available object tag names
      const objectTypes = Registry.objectTypes().map(type => type.name.replace("Model", "").toLowerCase());
      const objects = [];

      self.validate(VALIDATORS.CONFIG, rootModel);

      try {
        self.root = modelClass.create(rootModel);
      } catch (e) {
        console.error(e);
        return showError(e);
      }

      Tree.traverseTree(self.root, node => {
        if (node?.name) {
          self.names.put(node);
          if (objectTypes.includes(node.type)) objects.push(node.name);
        }
      });

      // initialize toName bindings [DOCS] name & toName are used to
      // connect different components to each other
      Tree.traverseTree(self.root, node => {
        const isControlTag = node.name && !objectTypes.includes(node.type);
        // auto-infer missed toName if there is only one object tag in the config

        if (isControlTag && !node.toname && objects.length === 1) {
          node.toname = objects[0];
        }

        if (node && node.toname) {
          const val = self.toNames.get(node.toname);

          if (val) {
            val.push(node.name);
          } else {
            self.toNames.set(node.toname, [node.name]);
          }
        }

        if (self.store.task && node.updateValue) node.updateValue(self.store);
      });

      return self.root;
    }

    function findNonInteractivePredictionResults() {
      return self.predictions.reduce((results, prediction) => {
        return [
          ...results,
          ...prediction._initialAnnotationObj.filter(result => result.interactive_mode === false).map(r => ({ ...r })),
        ];
      }, []);
    }

    function createItem(options) {
      const { user, config } = self.store;

      if (!self.root) initRoot(config);

      const pk = options.pk || options.id;

      //
      const node = {
        userGenerate: false,
        createdDate: Utils.UDate.currentISODate(),

        ...options,

        // id is internal so always new to prevent collisions
        id: guidGenerator(5),
        // pk and id may be missing, so undefined | string
        pk: pk && String(pk),
        root: self.root,
      };

      if (user && !("createdBy" in node)) node["createdBy"] = user.displayName;
      if (options.user) node.user = options.user;

      return node;
    }

    function addPrediction(options = {}) {
      options.editable = false;
      options.type = "prediction";

      const item = createItem(options);

      self.predictions.unshift(item);

      const record = self.predictions[0];

      return record;
    }

    function addAnnotation(options = {}) {
      options.type = "annotation";

      const item = createItem(options);

      if (item.userGenerate) {
        item.completed_by = getRoot(self).user?.id ?? undefined;
      }

      self.annotations.unshift(item);

      const record = self.annotations[0];

      record.addVersions({
        result: options.result,
        draft: options.draft,
      });

      return record;
    }

    function createAnnotation(options = { userGenerate: true }) {
      const result = isFF(FF_DEV_1621) ? findNonInteractivePredictionResults() : [];
      const c = self.addAnnotation({ ...options, result });

      if (result && result.length) {
        const ids = {};

        // Area id is <uniq-id>#<annotation-id> to be uniq across all tree
        result.forEach(r => {
          if ("id" in r) {
            const id = r.id.replace(/#.*$/, `#${c.id}`);

            ids[r.id] = id;
            r.id = id;
          }
        });

        result.forEach(r => {
          if (r.parent_id) {
            if (ids[r.parent_id]) r.parent_id = ids[r.parent_id];
            // impossible case but to not break the app better to reset it
            else r.parent_id = null;
          }
        });

        selectAnnotation(c.id);
        c.deserializeAnnotation(result);
        // reinit will trigger `updateObjects()` so we omit it here
        c.reinitHistory();
      }
      return c;
    }


    function addHistory(options = {}) {
      options.type = "history";

      const item = createItem(options);

      self.history.push(item);

      const record = self.history[self.history.length - 1];

      return record;
    }

    function clearHistory() {
      self.history.forEach(item => destroy(item));
      self.history.length = 0;
    }

    function selectHistory(item) {
      self.selectedHistory = item;
      setTimeout(() => {
        // update classifications after render
        const updatedItem = item ?? self.selected;

        updatedItem?.results
          .filter(r => r.area.classification)
          .forEach(r => r.from_name.updateFromResult?.(r.mainValue));
      });
    }

    function addAnnotationFromPrediction(entity) {
      // immutable work, because we'll change ids soon
      const s = entity._initialAnnotationObj.map(r => ({ ...r }));
      const c = self.addAnnotation({ userGenerate: true, result: s });

      const ids = {};

      // Area id is <uniq-id>#<annotation-id> to be uniq across all tree
      s.forEach(r => {
        if ("id" in r) {
          const id = r.id.replace(/#.*$/, `#${c.id}`);

          ids[r.id] = id;
          r.id = id;
        }
      });

      s.forEach(r => {
        if (r.parent_id) {
          if (ids[r.parent_id]) r.parent_id = ids[r.parent_id];
          // impossible case but to not break the app better to reset it
          else r.parent_id = null;
        }
      });

      selectAnnotation(c.id);
      c.deserializeAnnotation(s);
      // reinit will trigger `updateObjects()` so we omit it here
      c.reinitHistory();

      // parent link for the new annotations
      if (entity.pk) {
        if (entity.type === 'prediction') {
          c.parent_prediction = parseInt(entity.pk);
        }
        else if (entity.type === 'annotation') {
          c.parent_annotation = parseInt(entity.pk);
        }
      }

      return c;
    }

    /** ERRORS HANDLING */
    const handleErrors = errors => {
      self.addErrors(errors);
    };

    const addErrors = errors => {
      const ids = [];

      const newErrors = [...(self.validation ?? []), ...errors].reduce((res, error) => {
        const id = error.identifier;

        if (ids.indexOf(id) < 0) {
          ids.push(id);
          res.push(error);
        }

        return res;
      }, []);

      self.validation = newErrors;
    };

    const afterCreate = () => {
      self._validator = new DataValidator();
      self._validator.addErrorCallback(handleErrors);
    };

    const beforeDestroy = () => {
      self._validator.removeErrorCallback(handleErrors);
    };

    const validate = (validatorName, data) => {
      return self._validator.validate(validatorName, data);
    };

    return {
      afterCreate,
      beforeDestroy,

      toggleViewingAllAnnotations,
      toggleViewingAllPredictions,

      initRoot,

      addPrediction,
      addAnnotation,
      createAnnotation,
      addAnnotationFromPrediction,
      addHistory,
      clearHistory,
      selectHistory,

      addErrors,
      validate,

      selectAnnotation,
      selectPrediction,

      _selectItem,
      _unselectAll,

      deleteAnnotation,
    };
  });
