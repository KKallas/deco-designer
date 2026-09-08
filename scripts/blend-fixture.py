"""
Build tests/fixtures/golden-net.blend (+ .json ground truth) with Blender:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python scripts/blend-fixture.py
Material "golden net" mirrors the user's netting shader (3 × Voronoi → Ping-Pong →
Map Range → Multiply → Color Ramp → Principled); "grouped" uses a node group,
Noise, Mapping and a Mix shader; "plain" has no node tree; "textured" samples a
packed 4×4 image (docs/13-material-editor.md).
"""
import bpy, json, os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tests', 'fixtures')
bpy.ops.wm.read_homefile(use_empty=True)

def golden():
    m = bpy.data.materials.new('golden net'); m.use_nodes = True
    nt = m.node_tree; nodes, links = nt.nodes, nt.links
    for n in list(nodes): nodes.remove(n)
    out = nodes.new('ShaderNodeOutputMaterial'); out.location = (1200, 0)
    bsdf = nodes.new('ShaderNodeBsdfPrincipled'); bsdf.location = (900, 0)
    bsdf.inputs['Metallic'].default_value = 0.6
    bsdf.inputs['Roughness'].default_value = 0.314
    links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    ramp = nodes.new('ShaderNodeValToRGB'); ramp.location = (600, 0)
    ramp.color_ramp.elements[0].position = 0.0; ramp.color_ramp.elements[0].color = (0, 0, 0, 1)
    ramp.color_ramp.elements[1].position = 0.105; ramp.color_ramp.elements[1].color = (0.9, 0.55, 0.15, 1)
    links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])
    layers = []
    for i, (w, scale, rough, rand) in enumerate([(1.3, 50.0, 0.581, 0.570), (5.0, 60.0, 0.537, 0.5), (8.2, 51.5, 0.537, 0.519)]):
        v = nodes.new('ShaderNodeTexVoronoi'); v.location = (-600, -400 * i)
        v.voronoi_dimensions = '4D'; v.feature = 'F1'; v.distance = 'EUCLIDEAN'; v.normalize = False
        v.inputs['W'].default_value = w; v.inputs['Scale'].default_value = scale
        v.inputs['Detail'].default_value = 0.0; v.inputs['Roughness'].default_value = rough
        v.inputs['Lacunarity'].default_value = 0.0; v.inputs['Randomness'].default_value = rand
        pp = nodes.new('ShaderNodeMath'); pp.location = (-300, -400 * i); pp.operation = 'PINGPONG'; pp.use_clamp = True
        pp.inputs[1].default_value = -0.3 if i < 2 else -0.29
        links.new(v.outputs['Distance'], pp.inputs[0])
        mr = nodes.new('ShaderNodeMapRange'); mr.location = (0, -400 * i); mr.data_type = 'FLOAT'; mr.interpolation_type = 'LINEAR'; mr.clamp = True
        mr.inputs['From Min'].default_value = 0.0; mr.inputs['From Max'].default_value = 0.13
        mr.inputs['To Min'].default_value = 0.0; mr.inputs['To Max'].default_value = 1.0
        links.new(pp.outputs['Value'], mr.inputs['Value'])
        layers.append(mr)
    m1 = nodes.new('ShaderNodeMix'); m1.location = (250, 0); m1.data_type = 'RGBA'; m1.blend_type = 'MULTIPLY'; m1.clamp_factor = True; m1.clamp_result = False
    m1.inputs['Factor'].default_value = 1.0
    links.new(layers[0].outputs['Result'], m1.inputs[6]); links.new(layers[1].outputs['Result'], m1.inputs[7])  # A_Color, B_Color
    m2 = nodes.new('ShaderNodeMix'); m2.location = (450, 0); m2.data_type = 'RGBA'; m2.blend_type = 'MULTIPLY'; m2.clamp_factor = True
    links.new(m1.outputs[2], m2.inputs[6]); links.new(layers[2].outputs['Result'], m2.inputs[7])
    links.new(m2.outputs[2], ramp.inputs['Fac'])
    return m

def grouped():
    g = bpy.data.node_groups.new('Stripes', 'ShaderNodeTree')
    g.interface.new_socket('Vector', in_out='INPUT', socket_type='NodeSocketVector')
    s = g.interface.new_socket('Scale', in_out='INPUT', socket_type='NodeSocketFloat'); s.default_value = 4.0
    g.interface.new_socket('Fac', in_out='OUTPUT', socket_type='NodeSocketFloat')
    gi = g.nodes.new('NodeGroupInput'); go = g.nodes.new('NodeGroupOutput')
    sep = g.nodes.new('ShaderNodeSeparateXYZ')
    mul = g.nodes.new('ShaderNodeMath'); mul.operation = 'MULTIPLY'
    frac = g.nodes.new('ShaderNodeMath'); frac.operation = 'FRACT'
    g.links.new(gi.outputs['Vector'], sep.inputs[0]); g.links.new(sep.outputs['X'], mul.inputs[0]); g.links.new(gi.outputs['Scale'], mul.inputs[1])
    g.links.new(mul.outputs[0], frac.inputs[0]); g.links.new(frac.outputs[0], go.inputs['Fac'])

    m = bpy.data.materials.new('grouped'); m.use_nodes = True
    nt = m.node_tree; nodes, links = nt.nodes, nt.links
    for n in list(nodes): nodes.remove(n)
    out = nodes.new('ShaderNodeOutputMaterial')
    mixs = nodes.new('ShaderNodeMixShader')
    b1 = nodes.new('ShaderNodeBsdfPrincipled'); b1.inputs['Base Color'].default_value = (0.8, 0.1, 0.1, 1)
    em = nodes.new('ShaderNodeEmission'); em.inputs['Strength'].default_value = 2.0
    links.new(mixs.outputs[0], out.inputs['Surface']); links.new(b1.outputs[0], mixs.inputs[1]); links.new(em.outputs[0], mixs.inputs[2])
    tc = nodes.new('ShaderNodeTexCoord')
    mp = nodes.new('ShaderNodeMapping'); mp.vector_type = 'POINT'; mp.inputs['Scale'].default_value = (2, 2, 2); mp.inputs['Rotation'].default_value = (0, 0, 0.5)
    links.new(tc.outputs['Object'], mp.inputs['Vector'])
    grp = nodes.new('ShaderNodeGroup'); grp.node_tree = g; grp.inputs['Scale'].default_value = 6.0
    links.new(mp.outputs[0], grp.inputs['Vector'])
    noise = nodes.new('ShaderNodeTexNoise'); noise.inputs['Scale'].default_value = 3.0; noise.inputs['Detail'].default_value = 2.0
    links.new(tc.outputs['UV'], noise.inputs['Vector'])
    add = nodes.new('ShaderNodeMath'); add.operation = 'ADD'
    links.new(grp.outputs['Fac'], add.inputs[0]); links.new(noise.outputs['Fac'], add.inputs[1])
    links.new(add.outputs[0], b1.inputs['Roughness']); links.new(add.outputs[0], mixs.inputs['Fac'])
    rgb = nodes.new('ShaderNodeRGB'); rgb.outputs[0].default_value = (0.1, 0.4, 1.0, 1)
    links.new(rgb.outputs[0], em.inputs['Color'])
    mute = nodes.new('ShaderNodeMath'); mute.operation = 'SUBTRACT'; mute.mute = True
    links.new(noise.outputs['Fac'], mute.inputs[0]); links.new(mute.outputs[0], b1.inputs['Metallic'])
    return m

def plain():
    m = bpy.data.materials.new('plain'); m.use_nodes = False
    m.diffuse_color = (0.2, 0.6, 0.3, 1); m.metallic = 0.25; m.roughness = 0.7
    return m

def textured():
    """An Image Texture (packed generated image) → Base Color / Roughness, through a Mapping node."""
    img = bpy.data.images.new('net.png', 4, 4)
    px = []
    for y in range(4):
        for x in range(4):
            v = 1.0 if (x + y) % 2 == 0 else 0.1
            px += [v, v * 0.7, 0.1, 1.0]
    img.pixels = px
    img.pack()
    m = bpy.data.materials.new('textured'); m.use_nodes = True
    nt = m.node_tree; nodes, links = nt.nodes, nt.links
    for n in list(nodes): nodes.remove(n)
    out = nodes.new('ShaderNodeOutputMaterial'); bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    tex = nodes.new('ShaderNodeTexImage'); tex.image = img; tex.extension = 'REPEAT'
    links.new(tex.outputs['Color'], bsdf.inputs['Base Color']); links.new(tex.outputs['Alpha'], bsdf.inputs['Roughness'])
    tc = nodes.new('ShaderNodeTexCoord'); mp = nodes.new('ShaderNodeMapping'); mp.inputs['Scale'].default_value = (4, 4, 4)
    links.new(tc.outputs['UV'], mp.inputs['Vector']); links.new(mp.outputs['Vector'], tex.inputs['Vector'])
    return m

def enums():
    """One node per enum value so the importer's numeric tables can be checked against Blender."""
    m = bpy.data.materials.new('enums'); m.use_nodes = True
    nodes = m.node_tree.nodes
    def each(idname, prop):
        probe = nodes.new(idname)
        for item in probe.bl_rna.properties[prop].enum_items:
            n = nodes.new(idname)
            try: setattr(n, prop, item.identifier)
            except TypeError: nodes.remove(n); continue
            n.label = f'{prop}={item.identifier}'
        nodes.remove(probe)
    each('ShaderNodeMath', 'operation'); each('ShaderNodeVectorMath', 'operation')
    each('ShaderNodeMix', 'blend_type'); each('ShaderNodeMix', 'data_type'); each('ShaderNodeMix', 'factor_mode')
    each('ShaderNodeMapRange', 'interpolation_type'); each('ShaderNodeMapRange', 'data_type')
    each('ShaderNodeTexVoronoi', 'feature'); each('ShaderNodeTexVoronoi', 'distance'); each('ShaderNodeTexVoronoi', 'voronoi_dimensions')
    each('ShaderNodeTexNoise', 'noise_type'); each('ShaderNodeTexGradient', 'gradient_type'); each('ShaderNodeMapping', 'vector_type')
    each('ShaderNodeVectorRotate', 'rotation_type'); each('ShaderNodeClamp', 'clamp_type'); each('ShaderNodeSeparateColor', 'mode')
    each('ShaderNodeValToRGB', 'color_ramp') if False else None
    r = nodes.new('ShaderNodeValToRGB')
    for item in r.color_ramp.bl_rna.properties['interpolation'].enum_items:
        n = nodes.new('ShaderNodeValToRGB'); n.color_ramp.interpolation = item.identifier; n.label = f'ramp={item.identifier}'
    nodes.remove(r)
    return m

mats = [golden(), grouped(), plain(), textured(), enums()]
cube = bpy.data.objects.new('cube', bpy.data.meshes.new('cube')); bpy.context.scene.collection.objects.link(cube)
for m in mats: cube.data.materials.append(m)

def sock(s):
    d = {'identifier': s.identifier, 'name': s.name, 'type': s.type, 'enabled': s.enabled}
    if hasattr(s, 'default_value') and s.type in ('VALUE', 'RGBA', 'VECTOR', 'INT', 'BOOLEAN'):
        v = s.default_value
        d['value'] = [round(x, 6) for x in v] if hasattr(v, '__len__') else (round(v, 6) if isinstance(v, float) else v)
    return d

def tree(nt):
    ns = []
    for n in nt.nodes:
        d = {'name': n.name, 'idname': n.bl_idname, 'mute': n.mute, 'inputs': [sock(s) for s in n.inputs], 'outputs': [sock(s) for s in n.outputs]}
        d['label'] = n.label
        if n.bl_idname == 'ShaderNodeTexImage' and n.image:
            d['image'] = {'name': n.image.name, 'packed': n.image.packed_file is not None, 'size': n.image.packed_file.size if n.image.packed_file else 0}
        for p in ('operation', 'blend_type', 'data_type', 'interpolation_type', 'clamp', 'use_clamp', 'clamp_factor', 'clamp_result', 'feature', 'distance', 'voronoi_dimensions', 'noise_dimensions', 'noise_type', 'normalize', 'vector_type', 'gradient_type', 'rotation_type', 'clamp_type', 'mode', 'factor_mode', 'extension', 'projection'):
            if hasattr(n, p): d[p] = getattr(n, p)
        if n.bl_idname == 'ShaderNodeValToRGB':
            d['ramp'] = {'interpolation': n.color_ramp.interpolation, 'elements': [[round(e.position, 6), [round(c, 6) for c in e.color]] for e in n.color_ramp.elements]}
        if n.bl_idname == 'ShaderNodeGroup': d['group'] = n.node_tree.name
        ns.append(d)
    ls = [{'from': [l.from_node.name, l.from_socket.identifier], 'to': [l.to_node.name, l.to_socket.identifier], 'mute': l.is_muted} for l in nt.links]
    return {'nodes': ns, 'links': ls}

truth = {'blender': bpy.app.version_string, 'materials': [{'name': m.name, 'use_nodes': m.use_nodes, 'tree': tree(m.node_tree) if m.use_nodes else None,
          'viewport': {'color': [round(c, 6) for c in m.diffuse_color], 'metallic': round(m.metallic, 6), 'roughness': round(m.roughness, 6)}} for m in mats],
         'groups': {g.name: tree(g) for g in bpy.data.node_groups}}
os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, 'golden-net.json'), 'w') as f: json.dump(truth, f, indent=1)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'golden-net.blend'), compress=True)
print('fixture written')
