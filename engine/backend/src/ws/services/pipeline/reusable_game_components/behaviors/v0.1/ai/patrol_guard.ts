// also: sentry, route_walker, perimeter_defense, bodyguard, protection
// Patrol guard — friendly NPC that walks a patrol route
class PatrolGuardBehavior extends GameScript {
    _behaviorName = "patrol_guard"; _speed = 2; _range = 8; _dir = 1; _startX = 0; _currentAnim = "";
    onStart() { this._startX=this.entity.transform.position.x; this._dir=Math.random()<0.5?1:-1; }
    onUpdate(dt) { var p=this.entity.transform.position; var nX=p.x+this._dir*this._speed*dt;
        if(Math.abs(nX-this._startX)>this._range){this._dir*=-1;nX=p.x+this._dir*this._speed*dt;}
        this.scene.setPosition(this.entity.id,nX,p.y,p.z);this.entity.transform.setRotationEuler(0,this._dir>0?90:-90,0);
        this._playAnim("Walk");
    }
    _playAnim(n){if(this._currentAnim===n)return;this._currentAnim=n;if(this.entity.playAnimation)this.entity.playAnimation(n,{loop:true});}
}
